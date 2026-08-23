package panel

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"

	"gopkg.in/yaml.v3"
)

type App struct {
	opts      Options
	configs   *ConfigManager
	stats     *StatsStore
	logs      *logRing
	collector *Collector
	service   Service

	startOnce sync.Once
	closeOnce sync.Once
	cancel    context.CancelFunc
}

func New(opts Options) (*App, error) {
	defaults := DefaultOptions()
	if opts.ConfigDir == "" {
		opts.ConfigDir = defaults.ConfigDir
	}
	if opts.BaseConfig == "" {
		opts.BaseConfig = filepath.Join(opts.ConfigDir, "config.base.yaml")
	}
	if opts.EffectiveConfig == "" {
		opts.EffectiveConfig = filepath.Join(opts.ConfigDir, "config.yaml")
	}
	if opts.OverrideDir == "" {
		opts.OverrideDir = filepath.Join(opts.ConfigDir, "overrides")
	}
	if opts.StatsPath == "" {
		opts.StatsPath = filepath.Join(opts.ConfigDir, "statistics.db")
	}
	if opts.RuntimeDir == "" {
		opts.RuntimeDir = defaults.RuntimeDir
	}
	if opts.ManagerSocket == "" {
		opts.ManagerSocket = filepath.Join(opts.RuntimeDir, "manager.sock")
	}
	if opts.ControllerSocket == "" {
		opts.ControllerSocket = defaultControllerSocket
	}
	if opts.MihomoBinary == "" {
		opts.MihomoBinary = defaults.MihomoBinary
	}
	if opts.ServiceScript == "" {
		opts.ServiceScript = defaults.ServiceScript
	}
	if opts.IPIPURL == "" {
		opts.IPIPURL = defaultIPIPURL
	}
	if opts.IPSBURL == "" {
		opts.IPSBURL = defaultIPSBURL
	}
	if opts.Retention <= 0 || opts.Retention > 30*24*time.Hour {
		opts.Retention = 30 * 24 * time.Hour
	}
	if opts.ConnectionInterval <= 0 {
		opts.ConnectionInterval = 2 * time.Second
	}
	if opts.HealthTimeout <= 0 {
		opts.HealthTimeout = 10 * time.Second
	}
	if opts.Logger == nil {
		opts.Logger = defaults.Logger
	}
	if err := secureControllerRuntime(opts.ControllerSocket); err != nil {
		return nil, fmt.Errorf("secure Mihomo controller directory: %w", err)
	}
	if err := os.MkdirAll(filepath.Dir(opts.StatsPath), 0o700); err != nil {
		return nil, fmt.Errorf("create statistics directory: %w", err)
	}
	client := newMihomoClient(opts.ControllerSocket)
	if opts.HealthCheck == nil {
		opts.HealthCheck = func(ctx context.Context) error {
			var response struct {
				Version string `json:"version"`
			}
			if err := client.getJSON(ctx, "/version", &response); err != nil {
				return err
			}
			if response.Version == "" {
				return errors.New("Mihomo returned an empty version")
			}
			return nil
		}
	}
	if opts.FetchPublicIP == nil {
		opts.FetchPublicIP = defaultPublicIPFetcher(opts.IPIPURL, opts.IPSBURL)
	}
	configs, err := newConfigManager(opts)
	if err != nil {
		return nil, err
	}
	stats, err := openStats(opts.StatsPath, opts.Retention)
	if err != nil {
		return nil, fmt.Errorf("open statistics database: %w", err)
	}
	logs := newLogRing(1000, 1<<20)
	collector := newCollector(client, stats, logs, opts.Logger, opts.ConnectionInterval)
	service := opts.Service
	if service == nil {
		service = &initService{script: opts.ServiceScript, controllerSocket: opts.ControllerSocket}
	}
	return &App{opts: opts, configs: configs, stats: stats, logs: logs, collector: collector, service: service}, nil
}

func (app *App) Start(parent context.Context) {
	app.startOnce.Do(func() {
		ctx, cancel := context.WithCancel(parent)
		app.cancel = cancel
		app.collector.Start(ctx)
	})
}

func (app *App) Close() error {
	var closeError error
	app.closeOnce.Do(func() {
		if app.cancel != nil {
			app.cancel()
			app.collector.Wait()
		}
		closeError = app.stats.Close()
	})
	return closeError
}

func (app *App) Handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("/api/health", app.handle(http.MethodGet, app.health))
	mux.HandleFunc("/api/status", app.handle(http.MethodGet, app.status))
	mux.HandleFunc("/api/overview", app.handle(http.MethodGet, app.overview))
	mux.HandleFunc("/api/history", app.handle(http.MethodGet, app.history))
	mux.HandleFunc("/api/logs", app.handle(http.MethodGet, app.queryLogs))
	mux.HandleFunc("/api/config/get", app.handle(http.MethodPost, app.getConfig))
	mux.HandleFunc("/api/config/apply", app.handle(http.MethodPost, app.applyConfig))
	mux.HandleFunc("/api/overrides/get", app.handle(http.MethodPost, app.getOverrides))
	mux.HandleFunc("/api/overrides/draft", app.handle(http.MethodPost, app.saveOverrideDraft))
	mux.HandleFunc("/api/overrides/preview", app.handle(http.MethodPost, app.previewOverrides))
	mux.HandleFunc("/api/overrides/apply", app.handle(http.MethodPost, app.applyOverrides))
	mux.HandleFunc("/api/service/action", app.handle(http.MethodPost, app.serviceAction))
	mux.HandleFunc("/api/public-ip", app.handle(http.MethodPost, app.publicIP))
	mux.HandleFunc("/api/history/clear", app.handle(http.MethodPost, app.clearHistory))
	mux.HandleFunc("/", func(response http.ResponseWriter, _ *http.Request) {
		app.writeError(response, apiError(http.StatusNotFound, "not_found", "API endpoint not found", nil))
	})
	return http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		response.Header().Set("Cache-Control", "no-store")
		response.Header().Set("X-Content-Type-Options", "nosniff")
		response.Header().Set("Content-Security-Policy", "default-src 'none'")
		mux.ServeHTTP(response, request)
	})
}

type apiHandler func(http.ResponseWriter, *http.Request) (interface{}, error)

func (app *App) handle(method string, handler apiHandler) http.HandlerFunc {
	return func(response http.ResponseWriter, request *http.Request) {
		if request.Method != method {
			response.Header().Set("Allow", method)
			app.writeError(response, apiError(http.StatusMethodNotAllowed, "method_not_allowed", "Method not allowed", nil))
			return
		}
		data, err := handler(response, request)
		if err != nil {
			apiErr := asAPIError(err)
			if apiErr.Code == "internal_error" {
				app.opts.Logger.Printf("API %s: %v", request.URL.Path, err)
			}
			app.writeError(response, apiErr)
			return
		}
		app.writeJSON(response, http.StatusOK, map[string]interface{}{"ok": true, "data": data})
	}
}

func (app *App) writeError(response http.ResponseWriter, apiErr *APIError) {
	status := apiErr.Status
	if status == 0 {
		status = http.StatusInternalServerError
	}
	app.writeJSON(response, status, map[string]interface{}{"ok": false, "error": apiErr})
}

func (app *App) writeJSON(response http.ResponseWriter, status int, value interface{}) {
	var body bytes.Buffer
	encoder := json.NewEncoder(&body)
	encoder.SetEscapeHTML(true)
	if err := encoder.Encode(value); err != nil {
		body.Reset()
		_, _ = body.WriteString(`{"ok":false,"error":{"code":"encoding_failed","message":"Could not encode the API response"}}` + "\n")
		status = http.StatusInternalServerError
	}
	response.Header().Set("Content-Type", "application/json; charset=utf-8")
	response.Header().Set("Content-Length", strconv.Itoa(body.Len()))
	response.WriteHeader(status)
	_, _ = response.Write(body.Bytes())
}

func decodeBody(response http.ResponseWriter, request *http.Request, target interface{}) error {
	request.Body = http.MaxBytesReader(response, request.Body, maxRequestBytes)
	decoder := json.NewDecoder(request.Body)
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(target); err != nil {
		var maxBytes *http.MaxBytesError
		if errors.As(err, &maxBytes) {
			return apiError(413, "request_too_large", "Request exceeds 4 MiB", nil)
		}
		return apiError(400, "invalid_json", "Invalid request body", err.Error())
	}
	if err := decoder.Decode(&struct{}{}); err != io.EOF {
		return apiError(400, "invalid_json", "Request body must contain one JSON value", nil)
	}
	return nil
}

func (app *App) health(_ http.ResponseWriter, request *http.Request) (interface{}, error) {
	if err := app.opts.HealthCheck(request.Context()); err != nil {
		return nil, apiError(503, "mihomo_unavailable", "Mihomo controller is unavailable", err.Error())
	}
	return map[string]interface{}{"healthy": true}, nil
}

func (app *App) status(_ http.ResponseWriter, request *http.Request) (interface{}, error) {
	running, err := app.service.Running(request.Context())
	if err != nil {
		return nil, apiError(502, "service_state_failed", "Could not determine Mihomo service state", err.Error())
	}
	state := app.collector.Snapshot()
	return map[string]interface{}{
		"running": running, "controllerConnected": state.Connected, "controllerSocket": defaultControllerSocket,
		"version": state.Version, "lastError": state.LastError, "lastUpdate": state.LastUpdate,
	}, nil
}

func (app *App) overview(_ http.ResponseWriter, request *http.Request) (interface{}, error) {
	since, resolution, err := historyRange(request.URL.Query().Get("range"))
	if err != nil {
		return nil, err
	}
	running, serviceErr := app.service.Running(request.Context())
	if serviceErr != nil {
		return nil, apiError(502, "service_state_failed", "Could not determine Mihomo service state", serviceErr.Error())
	}
	result := map[string]interface{}{"serviceRunning": running, "current": app.collector.Snapshot(), "resolutionSeconds": int64(resolution.Seconds())}
	if request.URL.Query().Get("history") != "0" {
		points, err := app.stats.History(since)
		if err != nil {
			return nil, err
		}
		result["history"] = downsample(points, resolution)
	}
	return result, nil
}

func (app *App) history(_ http.ResponseWriter, request *http.Request) (interface{}, error) {
	since, resolution, err := historyRange(request.URL.Query().Get("range"))
	if err != nil {
		return nil, err
	}
	dimension := request.URL.Query().Get("dimension")
	limit, _ := strconv.Atoi(request.URL.Query().Get("limit"))
	if dimension != "" {
		aggregates, err := app.stats.Aggregates(since, dimension, limit)
		if err != nil {
			return nil, err
		}
		return map[string]interface{}{"dimension": dimension, "aggregates": aggregates}, nil
	}
	points, err := app.stats.History(since)
	if err != nil {
		return nil, err
	}
	return map[string]interface{}{"points": downsample(points, resolution), "resolutionSeconds": int64(resolution.Seconds())}, nil
}

func (app *App) queryLogs(_ http.ResponseWriter, request *http.Request) (interface{}, error) {
	cursor, err := strconv.ParseUint(request.URL.Query().Get("cursor"), 10, 64)
	if err != nil && request.URL.Query().Get("cursor") != "" {
		return nil, apiError(400, "invalid_cursor", "Log cursor must be an unsigned integer", nil)
	}
	limit, _ := strconv.Atoi(request.URL.Query().Get("limit"))
	entries, latest := app.logs.Query(cursor, limit, request.URL.Query().Get("level"), request.URL.Query().Get("q"))
	return map[string]interface{}{"entries": entries, "cursor": latest}, nil
}

func (app *App) getConfig(_ http.ResponseWriter, _ *http.Request) (interface{}, error) {
	return app.configs.Config()
}

func (app *App) applyConfig(response http.ResponseWriter, request *http.Request) (interface{}, error) {
	var body struct {
		Content  string `json:"content"`
		Revision string `json:"revision"`
	}
	if err := decodeBody(response, request, &body); err != nil {
		return nil, err
	}
	return app.configs.ApplyBase(request.Context(), body.Content, body.Revision)
}

func (app *App) getOverrides(_ http.ResponseWriter, _ *http.Request) (interface{}, error) {
	return app.configs.Overrides()
}

func (app *App) saveOverrideDraft(response http.ResponseWriter, request *http.Request) (interface{}, error) {
	var body struct {
		Items    []OverrideItem `json:"items"`
		Revision string         `json:"revision"`
	}
	if err := decodeBody(response, request, &body); err != nil {
		return nil, err
	}
	return app.configs.SaveDraft(body.Items, body.Revision)
}

func (app *App) previewOverrides(response http.ResponseWriter, request *http.Request) (interface{}, error) {
	var body struct {
		Revision string `json:"revision"`
	}
	if err := decodeBody(response, request, &body); err != nil {
		return nil, err
	}
	return app.configs.Preview(body.Revision)
}

func (app *App) applyOverrides(response http.ResponseWriter, request *http.Request) (interface{}, error) {
	var body struct {
		Revision string `json:"revision"`
		Digest   string `json:"digest"`
	}
	if err := decodeBody(response, request, &body); err != nil {
		return nil, err
	}
	return app.configs.ApplyOverrides(request.Context(), body.Revision, body.Digest)
}

func (app *App) serviceAction(response http.ResponseWriter, request *http.Request) (interface{}, error) {
	var body struct {
		Action string `json:"action"`
	}
	if err := decodeBody(response, request, &body); err != nil {
		return nil, err
	}
	if !allowedServiceAction(body.Action) {
		return nil, apiError(400, "invalid_service_action", "Action must be start, stop, restart, or reload", nil)
	}
	if err := app.service.Action(request.Context(), body.Action); err != nil {
		return nil, apiError(502, "service_action_failed", "Mihomo service action failed", err.Error())
	}
	running, err := app.service.Running(request.Context())
	if err != nil {
		return nil, apiError(502, "service_state_failed", "Could not determine Mihomo service state", err.Error())
	}
	return map[string]interface{}{"action": body.Action, "running": running}, nil
}

func (app *App) publicIP(_ http.ResponseWriter, request *http.Request) (interface{}, error) {
	configuration, err := app.configs.Config()
	if err != nil {
		return nil, err
	}
	information, err := app.opts.FetchPublicIP(request.Context(), configuration.Effective)
	if err != nil {
		return nil, apiError(502, "network_information_failed", "Could not query network information through Mihomo", err.Error())
	}
	return information, nil
}

func (app *App) clearHistory(_ http.ResponseWriter, _ *http.Request) (interface{}, error) {
	if err := app.stats.Clear(); err != nil {
		return nil, err
	}
	return map[string]interface{}{"cleared": true}, nil
}

func historyRange(value string) (time.Time, time.Duration, error) {
	now := time.Now()
	switch value {
	case "", "1h":
		return now.Add(-time.Hour), time.Minute, nil
	case "24h":
		return now.Add(-24 * time.Hour), 5 * time.Minute, nil
	case "7d":
		return now.Add(-7 * 24 * time.Hour), 30 * time.Minute, nil
	case "30d":
		return now.Add(-30 * 24 * time.Hour), time.Hour, nil
	default:
		return time.Time{}, 0, apiError(400, "invalid_range", "Range must be 1h, 24h, 7d, or 30d", nil)
	}
}

func downsample(points []HistoryPoint, resolution time.Duration) []HistoryPoint {
	if len(points) == 0 {
		return []HistoryPoint{}
	}
	type bucket struct {
		point HistoryPoint
		count float64
	}
	buckets := make(map[int64]*bucket)
	order := make([]int64, 0)
	seconds := int64(resolution.Seconds())
	for _, point := range points {
		key := point.Timestamp - point.Timestamp%seconds
		value := buckets[key]
		if value == nil {
			value = &bucket{point: HistoryPoint{Timestamp: key}}
			buckets[key] = value
			order = append(order, key)
		}
		value.point.Upload += point.Upload
		value.point.Download += point.Download
		value.point.Memory += point.Memory
		value.point.Connections += point.Connections
		value.count++
	}
	result := make([]HistoryPoint, 0, len(order))
	for _, key := range order {
		value := buckets[key]
		value.point.Upload /= value.count
		value.point.Download /= value.count
		value.point.Memory /= value.count
		value.point.Connections /= value.count
		result = append(result, value.point)
	}
	return result
}

func proxyPortFromYAML(content string) (int, error) {
	var configuration map[string]interface{}
	if err := yaml.Unmarshal([]byte(content), &configuration); err != nil {
		return 0, fmt.Errorf("parse effective configuration: %w", err)
	}
	for _, key := range []string{"mixed-port", "port"} {
		value, exists := configuration[key]
		if !exists {
			continue
		}
		switch typed := value.(type) {
		case int:
			if typed > 0 && typed <= 65535 {
				return typed, nil
			}
		case uint64:
			if typed > 0 && typed <= 65535 {
				return int(typed), nil
			}
		case string:
			port, err := strconv.Atoi(strings.TrimSpace(typed))
			if err == nil && port > 0 && port <= 65535 {
				return port, nil
			}
		}
		return 0, fmt.Errorf("%s must be a valid TCP port", key)
	}
	return 0, fmt.Errorf("effective configuration has neither mixed-port nor port")
}
