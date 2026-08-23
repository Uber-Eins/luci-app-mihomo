package panel

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
)

type initService struct {
	script           string
	controllerSocket string
}

func secureControllerRuntime(socketPath string) error {
	if filepath.Clean(socketPath) != defaultControllerSocket {
		return nil
	}
	directory := filepath.Dir(defaultControllerSocket)
	info, err := os.Lstat(directory)
	if errors.Is(err, os.ErrNotExist) {
		if err := os.MkdirAll(directory, 0o700); err != nil {
			return err
		}
		info, err = os.Lstat(directory)
	}
	if err != nil {
		return err
	}
	if info.Mode()&os.ModeSymlink != 0 || !info.IsDir() {
		return fmt.Errorf("%s is not a real directory", directory)
	}
	if err := os.Chown(directory, 0, 0); err != nil {
		return err
	}
	return os.Chmod(directory, 0o700)
}

func (service *initService) Running(ctx context.Context) (bool, error) {
	command := exec.CommandContext(ctx, service.script, "running")
	err := command.Run()
	if err == nil {
		return true, nil
	}
	var exitError *exec.ExitError
	if errors.As(err, &exitError) {
		return false, nil
	}
	return false, err
}

func (service *initService) Action(ctx context.Context, action string) error {
	if !allowedServiceAction(action) {
		return fmt.Errorf("unsupported service action %q", action)
	}
	if action != "stop" {
		if err := secureControllerRuntime(service.controllerSocket); err != nil {
			return fmt.Errorf("secure Mihomo controller directory: %w", err)
		}
	}
	message, err := runCappedCommand(ctx, service.script, []string{action}, 16<<10)
	if err != nil {
		if message == "" {
			message = err.Error()
		}
		return fmt.Errorf("mihomo %s failed: %s", action, message)
	}
	return nil
}

func allowedServiceAction(action string) bool {
	switch action {
	case "start", "stop", "restart", "reload":
		return true
	default:
		return false
	}
}

type cappedOutput struct {
	mu        sync.Mutex
	buffer    bytes.Buffer
	limit     int
	truncated bool
}

func (output *cappedOutput) Write(data []byte) (int, error) {
	output.mu.Lock()
	defer output.mu.Unlock()
	written := len(data)
	remaining := output.limit - output.buffer.Len()
	if remaining > 0 {
		if len(data) > remaining {
			_, _ = output.buffer.Write(data[:remaining])
			output.truncated = true
		} else {
			_, _ = output.buffer.Write(data)
		}
	} else if len(data) > 0 {
		output.truncated = true
	}
	return written, nil
}

func (output *cappedOutput) String() string {
	output.mu.Lock()
	defer output.mu.Unlock()
	message := strings.TrimSpace(output.buffer.String())
	if output.truncated {
		message += "\n… output truncated"
	}
	return strings.TrimSpace(message)
}

func runCappedCommand(ctx context.Context, path string, arguments []string, limit int) (string, error) {
	output := &cappedOutput{limit: limit}
	command := exec.CommandContext(ctx, path, arguments...)
	command.Stdout = output
	command.Stderr = output
	err := command.Run()
	return output.String(), err
}
