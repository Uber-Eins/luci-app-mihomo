package panel

import (
	"context"
	"errors"
	"log"
	"os"
	"time"
)

const (
	defaultControllerSocket = "/run/mihomo/mihomo.sock"
	defaultIPIPURL          = "https://myip.ipip.net/json"
	defaultIPSBURL          = "https://api.ip.sb/geoip"
	maxRequestBytes         = 4 << 20
)

// Service is the small portion of procd's service interface used by the panel.
// It is exported so integrators can replace it in API-level tests.
type Service interface {
	Running(context.Context) (bool, error)
	Action(context.Context, string) error
}

type ValidateFunc func(context.Context, string) error
type HealthFunc func(context.Context) error
type PublicIPFunc func(context.Context, string) (NetworkInformation, error)

type Options struct {
	ConfigDir          string
	BaseConfig         string
	EffectiveConfig    string
	OverrideDir        string
	StatsPath          string
	RuntimeDir         string
	ManagerSocket      string
	ControllerSocket   string
	MihomoBinary       string
	ServiceScript      string
	IPIPURL            string
	IPSBURL            string
	Retention          time.Duration
	ConnectionInterval time.Duration
	HealthTimeout      time.Duration
	Logger             *log.Logger

	Service       Service
	Validate      ValidateFunc
	HealthCheck   HealthFunc
	FetchPublicIP PublicIPFunc
}

func DefaultOptions() Options {
	return Options{
		ConfigDir:          "/etc/mihomo",
		BaseConfig:         "/etc/mihomo/config.base.yaml",
		EffectiveConfig:    "/etc/mihomo/config.yaml",
		OverrideDir:        "/etc/mihomo/overrides",
		StatsPath:          "/etc/mihomo/statistics.db",
		RuntimeDir:         "/run/luci-mihomo",
		ManagerSocket:      "/run/luci-mihomo/manager.sock",
		ControllerSocket:   defaultControllerSocket,
		MihomoBinary:       "/usr/bin/mihomo",
		ServiceScript:      "/etc/init.d/mihomo",
		IPIPURL:            defaultIPIPURL,
		IPSBURL:            defaultIPSBURL,
		Retention:          30 * 24 * time.Hour,
		ConnectionInterval: 2 * time.Second,
		HealthTimeout:      10 * time.Second,
		Logger:             log.New(os.Stderr, "luci-mihomo: ", log.LstdFlags),
	}
}

type APIError struct {
	Status  int         `json:"-"`
	Code    string      `json:"code"`
	Message string      `json:"message"`
	Details interface{} `json:"details,omitempty"`
}

func (e *APIError) Error() string { return e.Message }

func apiError(status int, code, message string, details interface{}) *APIError {
	return &APIError{Status: status, Code: code, Message: message, Details: details}
}

func asAPIError(err error) *APIError {
	if err == nil {
		return nil
	}
	var target *APIError
	if errors.As(err, &target) {
		return target
	}
	return apiError(500, "internal_error", "Internal error", nil)
}

type OverrideItem struct {
	ID      string `json:"id"`
	Name    string `json:"name"`
	Enabled bool   `json:"enabled"`
	Content string `json:"content"`
}

type NetworkInformation struct {
	IPIP NetworkInformationSource `json:"ipip"`
	IPSB NetworkInformationSource `json:"ipsb"`
}

type NetworkInformationSource struct {
	Address string `json:"address,omitempty"`
	Family  string `json:"family,omitempty"`
	Summary string `json:"summary,omitempty"`
	Error   string `json:"error,omitempty"`
}

type LogEntry struct {
	Sequence uint64    `json:"sequence"`
	Time     time.Time `json:"time"`
	Level    string    `json:"level"`
	Message  string    `json:"message"`
}

type HistoryPoint struct {
	Timestamp   int64   `json:"timestamp"`
	Upload      float64 `json:"upload"`
	Download    float64 `json:"download"`
	Memory      float64 `json:"memory"`
	Connections float64 `json:"connections"`
}

type Aggregate struct {
	Key      string `json:"key"`
	Count    uint64 `json:"count"`
	Upload   uint64 `json:"upload"`
	Download uint64 `json:"download"`
}
