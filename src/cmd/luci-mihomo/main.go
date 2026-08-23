package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"log"
	"net"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"syscall"
	"time"

	"github.com/camellia/luci-app-mihomo/internal/panel"
)

var version = "dev"

func main() {
	var (
		showVersion = flag.Bool("version", false, "print version and exit")
		runtimeDir  = flag.String("runtime-dir", "/run/luci-mihomo", "runtime directory")
		configDir   = flag.String("config-dir", "/etc/mihomo", "Mihomo configuration directory")
	)
	flag.Parse()

	if *showVersion {
		fmt.Println(version)
		return
	}

	logger := log.New(os.Stderr, "luci-mihomo: ", log.LstdFlags|log.Lmsgprefix)
	opts := panel.DefaultOptions()
	opts.RuntimeDir = *runtimeDir
	opts.ConfigDir = *configDir
	opts.BaseConfig = filepath.Join(*configDir, "config.base.yaml")
	opts.EffectiveConfig = filepath.Join(*configDir, "config.yaml")
	opts.OverrideDir = filepath.Join(*configDir, "overrides")
	opts.StatsPath = filepath.Join(*configDir, "statistics.db")
	opts.ManagerSocket = filepath.Join(*runtimeDir, "manager.sock")
	opts.Logger = logger

	app, err := panel.New(opts)
	if err != nil {
		logger.Fatalf("initialize: %v", err)
	}
	defer app.Close()

	if err := os.MkdirAll(opts.RuntimeDir, 0o755); err != nil {
		logger.Fatalf("create runtime directory: %v", err)
	}
	_ = os.Remove(opts.ManagerSocket)
	listener, err := net.Listen("unix", opts.ManagerSocket)
	if err != nil {
		logger.Fatalf("listen on %s: %v", opts.ManagerSocket, err)
	}
	defer func() {
		_ = listener.Close()
		_ = os.Remove(opts.ManagerSocket)
	}()
	if err := os.Chmod(opts.ManagerSocket, 0o600); err != nil {
		logger.Fatalf("secure manager socket: %v", err)
	}

	ctx, cancel := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer cancel()
	app.Start(ctx)

	server := &http.Server{
		Handler:           app.Handler(),
		ReadHeaderTimeout: 5 * time.Second,
		ReadTimeout:       90 * time.Second,
		WriteTimeout:      90 * time.Second,
		IdleTimeout:       30 * time.Second,
	}
	go func() {
		<-ctx.Done()
		shutdownCtx, shutdownCancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer shutdownCancel()
		_ = server.Shutdown(shutdownCtx)
	}()

	logger.Printf("manager API listening on %s", opts.ManagerSocket)
	if err := server.Serve(listener); err != nil && !errors.Is(err, http.ErrServerClosed) {
		logger.Fatalf("serve: %v", err)
	}
}
