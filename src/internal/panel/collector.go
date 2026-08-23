package panel

import (
	"context"
	"encoding/json"
	"fmt"
	"sort"
	"sync"
	"time"
)

type collectorState struct {
	Connected     bool          `json:"connected"`
	LastError     string        `json:"lastError,omitempty"`
	LastUpdate    time.Time     `json:"lastUpdate,omitempty"`
	Version       string        `json:"version,omitempty"`
	UploadSpeed   float64       `json:"uploadSpeed"`
	DownloadSpeed float64       `json:"downloadSpeed"`
	UploadTotal   uint64        `json:"uploadTotal"`
	DownloadTotal uint64        `json:"downloadTotal"`
	Memory        uint64        `json:"memory"`
	Active        int           `json:"active"`
	Rules         []ruleSummary `json:"rules"`
}

type overviewState struct {
	Connected  bool      `json:"connected"`
	LastError  string    `json:"lastError,omitempty"`
	LastUpdate time.Time `json:"lastUpdate,omitempty"`
	Version    string    `json:"version,omitempty"`
}

type realtimeState struct {
	Timestamp     int64   `json:"timestamp"`
	Connected     bool    `json:"connected"`
	LastError     string  `json:"lastError,omitempty"`
	UploadSpeed   float64 `json:"uploadSpeed"`
	DownloadSpeed float64 `json:"downloadSpeed"`
	UploadTotal   uint64  `json:"uploadTotal"`
	DownloadTotal uint64  `json:"downloadTotal"`
	Memory        uint64  `json:"memory"`
	Active        int     `json:"active"`
}

type Collector struct {
	client *mihomoClient
	stats  *StatsStore
	logs   *logRing
	logger interface{ Printf(string, ...interface{}) }

	mu                 sync.RWMutex
	state              collectorState
	previous           map[string]trackedConnection
	wg                 sync.WaitGroup
	connectionInterval time.Duration
}

func newCollector(client *mihomoClient, stats *StatsStore, logs *logRing, logger interface{ Printf(string, ...interface{}) }, connectionInterval time.Duration) *Collector {
	return &Collector{client: client, stats: stats, logs: logs, logger: logger, previous: make(map[string]trackedConnection), connectionInterval: connectionInterval}
}

func (collector *Collector) Start(ctx context.Context) {
	collector.run(ctx, collector.trafficLoop)
	collector.run(ctx, collector.connectionLoop)
	collector.run(ctx, collector.metadataLoop)
	collector.run(ctx, collector.memoryLoop)
	collector.run(ctx, collector.logLoop)
	collector.run(ctx, collector.flushLoop)
}

func (collector *Collector) run(ctx context.Context, loop func(context.Context)) {
	collector.wg.Add(1)
	go func() {
		defer collector.wg.Done()
		loop(ctx)
	}()
}

func (collector *Collector) Wait() { collector.wg.Wait() }

func (collector *Collector) Overview() overviewState {
	collector.mu.RLock()
	defer collector.mu.RUnlock()
	return overviewState{
		Connected: collector.state.Connected, LastError: collector.state.LastError,
		LastUpdate: collector.state.LastUpdate, Version: collector.state.Version,
	}
}

func (collector *Collector) Realtime() realtimeState {
	collector.mu.RLock()
	defer collector.mu.RUnlock()
	timestamp := collector.state.LastUpdate.Unix()
	if collector.state.LastUpdate.IsZero() {
		timestamp = time.Now().Unix()
	}
	return realtimeState{
		Timestamp: timestamp, Connected: collector.state.Connected, LastError: collector.state.LastError,
		UploadSpeed: collector.state.UploadSpeed, DownloadSpeed: collector.state.DownloadSpeed,
		UploadTotal: collector.state.UploadTotal, DownloadTotal: collector.state.DownloadTotal,
		Memory: collector.state.Memory, Active: collector.state.Active,
	}
}

func (collector *Collector) Rules(limit int) []ruleSummary {
	collector.mu.RLock()
	defer collector.mu.RUnlock()
	if limit < 1 || limit > len(collector.state.Rules) {
		limit = len(collector.state.Rules)
	}
	return append([]ruleSummary(nil), collector.state.Rules[:limit]...)
}

func (collector *Collector) trafficLoop(ctx context.Context) {
	backoff := time.Second
	reportedFailure := false
	for ctx.Err() == nil {
		received := false
		err := collector.client.streamJSON(ctx, "/traffic", func(raw json.RawMessage) {
			var payload struct {
				Up        uint64 `json:"up"`
				Down      uint64 `json:"down"`
				UpTotal   uint64 `json:"upTotal"`
				DownTotal uint64 `json:"downTotal"`
			}
			if json.Unmarshal(raw, &payload) != nil {
				return
			}
			received = true
			now := time.Now()
			collector.mu.Lock()
			collector.state.Connected = true
			collector.state.LastError = ""
			collector.state.LastUpdate = now
			collector.state.UploadSpeed = float64(payload.Up)
			collector.state.DownloadSpeed = float64(payload.Down)
			collector.state.UploadTotal = payload.UpTotal
			collector.state.DownloadTotal = payload.DownTotal
			memory := collector.state.Memory
			active := collector.state.Active
			collector.mu.Unlock()
			collector.stats.RecordSample(now, float64(payload.Up), float64(payload.Down), float64(memory), active)
		})
		if ctx.Err() != nil {
			return
		}
		if received {
			reportedFailure = false
		}
		if err != nil && !reportedFailure {
			collector.logger.Printf("traffic stream: %v", err)
			reportedFailure = true
		}
		if !waitBackoff(ctx, backoff) {
			return
		}
		if received {
			backoff = time.Second
		} else {
			backoff = min(backoff*2, 30*time.Second)
		}
	}
}

func (collector *Collector) connectionLoop(ctx context.Context) {
	ticker := time.NewTicker(collector.connectionInterval)
	defer ticker.Stop()
	collector.pollConnections(ctx)
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			collector.pollConnections(ctx)
		}
	}
}

func (collector *Collector) pollConnections(ctx context.Context) {
	var snapshot connectionSnapshot
	if err := collector.client.getJSON(ctx, "/connections", &snapshot); err != nil {
		collector.mu.Lock()
		collector.state.Connected = false
		collector.state.LastError = err.Error()
		collector.mu.Unlock()
		return
	}
	now := time.Now()
	current := make(map[string]trackedConnection, len(snapshot.Connections))
	for _, connection := range snapshot.Connections {
		current[connection.ID] = trackConnection(connection)
	}
	for id, connection := range collector.previous {
		if _, exists := current[id]; !exists {
			collector.stats.RecordClosed(now, connection.dimensions(), connection.Upload, connection.Download)
		}
	}
	collector.previous = current

	collector.mu.Lock()
	collector.state.Connected = true
	collector.state.LastError = ""
	collector.state.LastUpdate = now
	collector.state.Active = len(snapshot.Connections)
	collector.mu.Unlock()
}

func (collector *Collector) metadataLoop(ctx context.Context) {
	versionTicker := time.NewTicker(30 * time.Second)
	rulesTicker := time.NewTicker(10 * time.Second)
	defer versionTicker.Stop()
	defer rulesTicker.Stop()
	collector.pollVersion(ctx)
	collector.pollRules(ctx)
	for {
		select {
		case <-ctx.Done():
			return
		case <-versionTicker.C:
			collector.pollVersion(ctx)
		case <-rulesTicker.C:
			collector.pollRules(ctx)
		}
	}
}

func (collector *Collector) pollVersion(ctx context.Context) {
	var response struct {
		Version string `json:"version"`
	}
	if err := collector.client.getJSON(ctx, "/version", &response); err == nil {
		collector.mu.Lock()
		collector.state.Version = response.Version
		collector.mu.Unlock()
	}
}

func (collector *Collector) pollRules(ctx context.Context) {
	var response rulesResponse
	if err := collector.client.getJSON(ctx, "/rules", &response); err != nil {
		return
	}
	rules := make([]ruleSummary, 0, len(response.Rules))
	for _, rule := range response.Rules {
		rules = append(rules, ruleSummary{Type: rule.Type, Payload: rule.Payload, Proxy: rule.Proxy, HitCount: rule.Extra.HitCount})
	}
	sort.SliceStable(rules, func(i, j int) bool { return rules[i].HitCount > rules[j].HitCount })
	if len(rules) > 100 {
		rules = rules[:100]
	}
	collector.mu.Lock()
	collector.state.Rules = rules
	collector.mu.Unlock()
}

func (collector *Collector) memoryLoop(ctx context.Context) {
	backoff := time.Second
	reportedFailure := false
	for ctx.Err() == nil {
		received := false
		err := collector.client.streamJSON(ctx, "/memory", func(raw json.RawMessage) {
			var payload struct {
				InUse   uint64 `json:"inuse"`
				OSLimit uint64 `json:"oslimit"`
			}
			if json.Unmarshal(raw, &payload) == nil {
				received = true
				collector.mu.Lock()
				collector.state.Memory = payload.InUse
				collector.mu.Unlock()
			}
		})
		if ctx.Err() != nil {
			return
		}
		if received {
			reportedFailure = false
		}
		if err != nil && !reportedFailure {
			collector.logger.Printf("memory stream: %v", err)
			reportedFailure = true
		}
		if !waitBackoff(ctx, backoff) {
			return
		}
		if received {
			backoff = time.Second
		} else {
			backoff = min(backoff*2, 30*time.Second)
		}
	}
}

func (collector *Collector) logLoop(ctx context.Context) {
	backoff := time.Second
	reportedFailure := false
	for ctx.Err() == nil {
		received := false
		err := collector.client.streamJSON(ctx, "/logs?level=debug", func(raw json.RawMessage) {
			var payload struct {
				Type    string `json:"type"`
				Payload string `json:"payload"`
			}
			if json.Unmarshal(raw, &payload) == nil {
				received = true
				collector.logs.Add(payload.Type, payload.Payload)
			}
		})
		if ctx.Err() != nil {
			return
		}
		if received {
			reportedFailure = false
		}
		if err != nil && !reportedFailure {
			collector.logger.Printf("log stream: %v", err)
			reportedFailure = true
		}
		if !waitBackoff(ctx, backoff) {
			return
		}
		if received {
			backoff = time.Second
		} else {
			backoff = min(backoff*2, 30*time.Second)
		}
	}
}

func (collector *Collector) flushLoop(ctx context.Context) {
	ticker := time.NewTicker(15 * time.Minute)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			if err := collector.stats.Flush(); err != nil {
				collector.logger.Printf("flush statistics: %v", err)
			}
		}
	}
}

func waitBackoff(ctx context.Context, duration time.Duration) bool {
	select {
	case <-ctx.Done():
		return false
	case <-time.After(duration):
		return true
	}
}

func (collector *Collector) Health(ctx context.Context) error {
	var response struct {
		Version string `json:"version"`
	}
	if err := collector.client.getJSON(ctx, "/version", &response); err != nil {
		return err
	}
	if response.Version == "" {
		return fmt.Errorf("Mihomo returned an empty version")
	}
	return nil
}
