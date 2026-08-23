package panel_test

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/camellia/luci-app-mihomo/internal/panel"
	"gopkg.in/yaml.v3"
)

type fakeService struct {
	mu      sync.Mutex
	running bool
	actions []string
	errors  map[string]error
}

func (service *fakeService) Running(context.Context) (bool, error) {
	service.mu.Lock()
	defer service.mu.Unlock()
	return service.running, nil
}

func (service *fakeService) Action(_ context.Context, action string) error {
	service.mu.Lock()
	defer service.mu.Unlock()
	service.actions = append(service.actions, action)
	if err := service.errors[action]; err != nil {
		return err
	}
	switch action {
	case "start", "restart":
		service.running = true
	case "stop":
		service.running = false
	}
	return nil
}

func (service *fakeService) Actions() []string {
	service.mu.Lock()
	defer service.mu.Unlock()
	return append([]string(nil), service.actions...)
}

type apiFixture struct {
	t       *testing.T
	dir     string
	opts    panel.Options
	app     *panel.App
	server  *httptest.Server
	service *fakeService
}

func newAPIFixture(t *testing.T, configure func(*panel.Options, *fakeService)) *apiFixture {
	t.Helper()
	directory := t.TempDir()
	service := &fakeService{errors: make(map[string]error)}
	opts := panel.DefaultOptions()
	opts.ConfigDir = directory
	opts.BaseConfig = filepath.Join(directory, "config.base.yaml")
	opts.EffectiveConfig = filepath.Join(directory, "config.yaml")
	opts.OverrideDir = filepath.Join(directory, "overrides")
	opts.StatsPath = filepath.Join(directory, "statistics.db")
	opts.RuntimeDir = filepath.Join(directory, "run")
	opts.ManagerSocket = filepath.Join(opts.RuntimeDir, "manager.sock")
	opts.ControllerSocket = filepath.Join(directory, "missing-mihomo.sock")
	opts.Logger = log.New(io.Discard, "", 0)
	opts.Service = service
	opts.Validate = func(context.Context, string) error { return nil }
	opts.HealthCheck = func(context.Context) error { return nil }
	if configure != nil {
		configure(&opts, service)
	}
	app, err := panel.New(opts)
	if err != nil {
		t.Fatalf("create panel: %v", err)
	}
	server := httptest.NewServer(app.Handler())
	fixture := &apiFixture{t: t, dir: directory, opts: opts, app: app, server: server, service: service}
	t.Cleanup(func() {
		server.Close()
		if err := app.Close(); err != nil {
			t.Errorf("close panel: %v", err)
		}
	})
	return fixture
}

func (fixture *apiFixture) request(method, path string, body interface{}) (int, map[string]interface{}) {
	fixture.t.Helper()
	var reader io.Reader
	if body != nil {
		data, err := json.Marshal(body)
		if err != nil {
			fixture.t.Fatalf("encode API request: %v", err)
		}
		reader = bytes.NewReader(data)
	}
	request, err := http.NewRequest(method, fixture.server.URL+path, reader)
	if err != nil {
		fixture.t.Fatalf("create API request: %v", err)
	}
	if body != nil {
		request.Header.Set("Content-Type", "application/json")
	}
	response, err := fixture.server.Client().Do(request)
	if err != nil {
		fixture.t.Fatalf("call API: %v", err)
	}
	defer response.Body.Close()
	var envelope map[string]interface{}
	if err := json.NewDecoder(response.Body).Decode(&envelope); err != nil {
		fixture.t.Fatalf("decode API response (%s): %v", path, err)
	}
	return response.StatusCode, envelope
}

func dataObject(t *testing.T, envelope map[string]interface{}) map[string]interface{} {
	t.Helper()
	if envelope["ok"] != true {
		t.Fatalf("API returned an error: %#v", envelope)
	}
	data, ok := envelope["data"].(map[string]interface{})
	if !ok {
		t.Fatalf("API data is not an object: %#v", envelope["data"])
	}
	return data
}

func errorCode(t *testing.T, envelope map[string]interface{}) string {
	t.Helper()
	errorObject, ok := envelope["error"].(map[string]interface{})
	if !ok {
		t.Fatalf("API error is not an object: %#v", envelope)
	}
	return fmt.Sprint(errorObject["code"])
}

func TestConfigurationAPIRejectsInvalidCandidatesWithoutTouchingFormalFiles(t *testing.T) {
	fixture := newAPIFixture(t, func(opts *panel.Options, _ *fakeService) {
		opts.Validate = func(_ context.Context, candidate string) error {
			content, err := os.ReadFile(candidate)
			if err != nil {
				return err
			}
			if strings.Contains(string(content), "reject-me") {
				return errors.New("test validator rejected reject-me")
			}
			return nil
		}
	})
	_, getEnvelope := fixture.request(http.MethodPost, "/api/config/get", map[string]interface{}{})
	configuration := dataObject(t, getEnvelope)
	baseBefore, _ := os.ReadFile(fixture.opts.BaseConfig)
	effectiveBefore, _ := os.ReadFile(fixture.opts.EffectiveConfig)

	status, invalidYAML := fixture.request(http.MethodPost, "/api/config/apply", map[string]interface{}{
		"content": "mixed-port: [\n", "revision": configuration["baseRevision"],
	})
	if status != http.StatusUnprocessableEntity || errorCode(t, invalidYAML) != "invalid_yaml" {
		t.Fatalf("unexpected invalid-YAML response: status=%d body=%#v", status, invalidYAML)
	}

	status, rejected := fixture.request(http.MethodPost, "/api/config/apply", map[string]interface{}{
		"content": "mixed-port: 7890\nmarker: reject-me\n", "revision": configuration["baseRevision"],
	})
	if status != http.StatusUnprocessableEntity || errorCode(t, rejected) != "mihomo_validation_failed" {
		t.Fatalf("unexpected validator response: status=%d body=%#v", status, rejected)
	}
	baseAfter, _ := os.ReadFile(fixture.opts.BaseConfig)
	effectiveAfter, _ := os.ReadFile(fixture.opts.EffectiveConfig)
	if !bytes.Equal(baseBefore, baseAfter) || !bytes.Equal(effectiveBefore, effectiveAfter) {
		t.Fatal("an invalid candidate changed a formal configuration file")
	}
	if len(fixture.service.Actions()) != 0 {
		t.Fatalf("validation failure triggered service actions: %v", fixture.service.Actions())
	}
}

func TestConfigurationAPIAppliesAtomicallyAndPreservesStoppedState(t *testing.T) {
	fixture := newAPIFixture(t, nil)
	_, getEnvelope := fixture.request(http.MethodPost, "/api/config/get", map[string]interface{}{})
	configuration := dataObject(t, getEnvelope)
	content := "mixed-port: 8899\nexternal-controller-unix: /tmp/untrusted.sock\nmode: global\n"
	status, appliedEnvelope := fixture.request(http.MethodPost, "/api/config/apply", map[string]interface{}{
		"content": content, "revision": configuration["baseRevision"],
	})
	if status != http.StatusOK {
		t.Fatalf("apply failed: status=%d body=%#v", status, appliedEnvelope)
	}
	applied := dataObject(t, appliedEnvelope)
	if applied["serviceWasRunning"] != false || applied["serviceReloaded"] != false {
		t.Fatalf("stopped state was not preserved: %#v", applied)
	}
	if len(fixture.service.Actions()) != 0 {
		t.Fatalf("stopped Mihomo received service actions: %v", fixture.service.Actions())
	}
	base, _ := os.ReadFile(fixture.opts.BaseConfig)
	effective, _ := os.ReadFile(fixture.opts.EffectiveConfig)
	if string(base) != content {
		t.Fatalf("source configuration differs from browser content:\n%s", base)
	}
	if !strings.Contains(string(effective), "external-controller-unix: /run/mihomo/mihomo.sock") || strings.Contains(string(effective), "/tmp/untrusted.sock") {
		t.Fatalf("effective configuration does not enforce the controller socket:\n%s", effective)
	}
	status, stale := fixture.request(http.MethodPost, "/api/config/apply", map[string]interface{}{
		"content": "mixed-port: 9999\n", "revision": configuration["baseRevision"],
	})
	if status != http.StatusConflict || errorCode(t, stale) != "revision_conflict" {
		t.Fatalf("stale update was not rejected: status=%d body=%#v", status, stale)
	}
}

func TestConfigurationAPIAdoptsExistingConfigAndEnablesUnixController(t *testing.T) {
	legacy := "mixed-port: 7890\nsecret: keep-this-secret\nmode: rule\n"
	fixture := newAPIFixture(t, func(opts *panel.Options, _ *fakeService) {
		if err := os.WriteFile(opts.EffectiveConfig, []byte(legacy), 0o600); err != nil {
			t.Fatalf("seed existing Mihomo configuration: %v", err)
		}
	})

	status, envelope := fixture.request(http.MethodPost, "/api/config/get", map[string]interface{}{})
	configuration := dataObject(t, envelope)
	if status != http.StatusOK {
		t.Fatalf("read adopted configuration: status=%d body=%#v", status, envelope)
	}
	if configuration["base"] != legacy {
		t.Fatalf("existing configuration was not preserved as the editable source:\n%s", configuration["base"])
	}
	effective := fmt.Sprint(configuration["effective"])
	if !strings.Contains(effective, "external-controller-unix: /run/mihomo/mihomo.sock") || !strings.Contains(effective, "secret: keep-this-secret") {
		t.Fatalf("adopted effective configuration is incomplete:\n%s", effective)
	}
	if len(fixture.service.Actions()) != 0 {
		t.Fatalf("stopped Mihomo received service actions during adoption: %v", fixture.service.Actions())
	}
}

func TestOverrideAPIPreviewsOrderedClashPartyMergeBeforeActivation(t *testing.T) {
	fixture := newAPIFixture(t, nil)
	_, configEnvelope := fixture.request(http.MethodPost, "/api/config/get", map[string]interface{}{})
	configuration := dataObject(t, configEnvelope)
	base := "mixed-port: 7890\nprofile:\n  retained: true\nproxies:\n  - base\n'+literal': base\n"
	status, applyBase := fixture.request(http.MethodPost, "/api/config/apply", map[string]interface{}{"content": base, "revision": configuration["baseRevision"]})
	if status != http.StatusOK {
		t.Fatalf("seed base configuration: %#v", applyBase)
	}

	_, getEnvelope := fixture.request(http.MethodPost, "/api/overrides/get", map[string]interface{}{})
	overrides := dataObject(t, getEnvelope)
	items := []panel.OverrideItem{
		{ID: "first", Name: "Prepend and append", Enabled: true, Content: "+proxies:\n  - first\nproxies+:\n  - last\nprofile:\n  from_first: true\n"},
		{ID: "force", Name: "Force object", Enabled: true, Content: "profile!:\n  forced: true\n<+literal>: escaped\n"},
		{ID: "later", Name: "Later merge", Enabled: true, Content: "profile:\n  later: true\nexternal-controller-unix: /tmp/not-allowed.sock\n"},
		{ID: "disabled", Name: "Disabled invalid YAML", Enabled: false, Content: ": definitely invalid"},
	}
	status, savedEnvelope := fixture.request(http.MethodPost, "/api/overrides/draft", map[string]interface{}{"items": items, "revision": overrides["draftRevision"]})
	if status != http.StatusOK {
		t.Fatalf("save override draft: status=%d body=%#v", status, savedEnvelope)
	}
	saved := dataObject(t, savedEnvelope)
	status, previewEnvelope := fixture.request(http.MethodPost, "/api/overrides/preview", map[string]interface{}{"revision": saved["draftRevision"]})
	if status != http.StatusOK {
		t.Fatalf("preview override draft: status=%d body=%#v", status, previewEnvelope)
	}
	preview := dataObject(t, previewEnvelope)
	previewYAML := fmt.Sprint(preview["yaml"])
	var decoded map[string]interface{}
	if err := yaml.Unmarshal([]byte(previewYAML), &decoded); err != nil {
		t.Fatalf("preview is not YAML: %v\n%s", err, previewYAML)
	}
	proxies, ok := decoded["proxies"].([]interface{})
	if !ok || fmt.Sprint(proxies) != "[first base last]" {
		t.Fatalf("array operators were not applied in order: %#v", decoded["proxies"])
	}
	profile, ok := decoded["profile"].(map[string]interface{})
	if !ok || profile["forced"] != true || profile["later"] != true || profile["retained"] != nil || profile["from_first"] != nil {
		t.Fatalf("force/deep merge result is wrong: %#v", decoded["profile"])
	}
	if decoded["+literal"] != "escaped" {
		t.Fatalf("escaped key was not preserved: %#v", decoded)
	}
	if decoded["external-controller-unix"] != "/run/mihomo/mihomo.sock" {
		t.Fatalf("fixed controller socket was overridden: %#v", decoded["external-controller-unix"])
	}
	if strings.Contains(previewYAML, "definitely invalid") {
		t.Fatal("disabled override affected preview")
	}

	status, activatedEnvelope := fixture.request(http.MethodPost, "/api/overrides/apply", map[string]interface{}{
		"revision": preview["draftRevision"], "digest": preview["digest"],
	})
	if status != http.StatusOK {
		t.Fatalf("activate override preview: status=%d body=%#v", status, activatedEnvelope)
	}
	_, finalEnvelope := fixture.request(http.MethodPost, "/api/overrides/get", map[string]interface{}{})
	finalState := dataObject(t, finalEnvelope)
	if finalState["changed"] != false || finalState["draftRevision"] != finalState["activeRevision"] {
		t.Fatalf("active override state does not match draft: %#v", finalState)
	}
	effective, _ := os.ReadFile(fixture.opts.EffectiveConfig)
	if string(effective) != previewYAML {
		t.Fatalf("activated effective YAML differs from the reviewed preview\npreview:\n%s\neffective:\n%s", previewYAML, effective)
	}
}

func TestConfigurationAPIRollsBackWhenReloadHealthCheckFails(t *testing.T) {
	fixture := newAPIFixture(t, func(opts *panel.Options, service *fakeService) {
		service.running = true
		opts.HealthTimeout = 30 * time.Millisecond
		opts.HealthCheck = func(context.Context) error { return errors.New("controller unhealthy") }
	})
	_, getEnvelope := fixture.request(http.MethodPost, "/api/config/get", map[string]interface{}{})
	configuration := dataObject(t, getEnvelope)
	baseBefore, _ := os.ReadFile(fixture.opts.BaseConfig)
	effectiveBefore, _ := os.ReadFile(fixture.opts.EffectiveConfig)
	status, failed := fixture.request(http.MethodPost, "/api/config/apply", map[string]interface{}{
		"content": "mixed-port: 9000\n", "revision": configuration["baseRevision"],
	})
	if status != http.StatusBadGateway || errorCode(t, failed) != "reload_rolled_back" {
		t.Fatalf("unexpected rollback response: status=%d body=%#v", status, failed)
	}
	baseAfter, _ := os.ReadFile(fixture.opts.BaseConfig)
	effectiveAfter, _ := os.ReadFile(fixture.opts.EffectiveConfig)
	if !bytes.Equal(baseBefore, baseAfter) || !bytes.Equal(effectiveBefore, effectiveAfter) {
		t.Fatal("formal files were not restored after an unhealthy reload")
	}
	if got := fmt.Sprint(fixture.service.Actions()); got != "[reload restart]" {
		t.Fatalf("unexpected rollback service sequence: %s", got)
	}
}

func TestServiceAndPublicIPAPIsExposeOnlyUserActions(t *testing.T) {
	var ipipCalled atomic.Bool
	var ipsbCalled atomic.Bool
	proxy := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		response.Header().Set("Content-Type", "application/json")
		switch request.URL.Host {
		case "ipip.invalid":
			ipipCalled.Store(true)
			_, _ = io.WriteString(response, `{"ret":"ok","data":{"ip":"203.0.113.8","location":["中国","福建","福州","电信"]}}`)
		case "ipsb.invalid":
			ipsbCalled.Store(true)
			_, _ = io.WriteString(response, `{"ip":"2001:db8::8","country":"United States","organization":"Example Networks Inc"}`)
		default:
			t.Errorf("network information request did not retain destination host: %s", request.URL.String())
			http.Error(response, "unexpected destination", http.StatusBadRequest)
		}
	}))
	defer proxy.Close()
	proxyURL, err := url.Parse(proxy.URL)
	if err != nil {
		t.Fatalf("parse fake proxy URL: %v", err)
	}
	_, port, err := net.SplitHostPort(proxyURL.Host)
	if err != nil {
		t.Fatalf("parse fake proxy port: %v", err)
	}
	fixture := newAPIFixture(t, func(opts *panel.Options, _ *fakeService) {
		opts.IPIPURL = "http://ipip.invalid/json"
		opts.IPSBURL = "http://ipsb.invalid/geoip"
	})
	_, configEnvelope := fixture.request(http.MethodPost, "/api/config/get", map[string]interface{}{})
	configuration := dataObject(t, configEnvelope)
	status, configApply := fixture.request(http.MethodPost, "/api/config/apply", map[string]interface{}{
		"content": "mixed-port: " + port + "\n", "revision": configuration["baseRevision"],
	})
	if status != http.StatusOK {
		t.Fatalf("configure fake Mihomo proxy: status=%d body=%#v", status, configApply)
	}
	status, invalid := fixture.request(http.MethodPost, "/api/service/action", map[string]interface{}{"action": "enable"})
	if status != http.StatusBadRequest || errorCode(t, invalid) != "invalid_service_action" {
		t.Fatalf("unsupported service action was accepted: status=%d body=%#v", status, invalid)
	}
	status, startedEnvelope := fixture.request(http.MethodPost, "/api/service/action", map[string]interface{}{"action": "start"})
	if status != http.StatusOK || dataObject(t, startedEnvelope)["running"] != true {
		t.Fatalf("start action failed: status=%d body=%#v", status, startedEnvelope)
	}
	status, ipEnvelope := fixture.request(http.MethodPost, "/api/public-ip", map[string]interface{}{})
	information := dataObject(t, ipEnvelope)
	ipip, ipipOK := information["ipip"].(map[string]interface{})
	ipsb, ipsbOK := information["ipsb"].(map[string]interface{})
	if status != http.StatusOK || !ipipOK || !ipsbOK ||
		ipip["address"] != "203.0.113.8" || ipip["summary"] != "中国 福建 福州 电信" ||
		ipsb["address"] != "2001:db8::8" || ipsb["summary"] != "United States Example Networks Inc" ||
		!ipipCalled.Load() || !ipsbCalled.Load() {
		t.Fatalf("network information API did not return both proxied sources: status=%d body=%#v ipip=%v ipsb=%v", status, ipEnvelope, ipipCalled.Load(), ipsbCalled.Load())
	}
}

func TestOverviewAndLogsAPIPersistCollectedUserHistoryAcrossRestart(t *testing.T) {
	directory := t.TempDir()
	socketPath := filepath.Join(directory, "mihomo.sock")
	listener, err := net.Listen("unix", socketPath)
	if err != nil {
		t.Fatalf("listen on fake Mihomo socket: %v", err)
	}
	var connectionCalls atomic.Uint64
	var logCalls atomic.Uint64
	var unexpectedAuthorization atomic.Uint64
	fakeMihomo := &http.Server{Handler: http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		if request.Header.Get("Authorization") != "" {
			unexpectedAuthorization.Add(1)
			http.Error(response, "Unix socket requests must not rely on controller authorization", http.StatusBadRequest)
			return
		}
		response.Header().Set("Content-Type", "application/json")
		switch request.URL.Path {
		case "/connections":
			call := connectionCalls.Add(1)
			if call == 1 {
				_, _ = io.WriteString(response, `{"downloadTotal":100,"uploadTotal":50,"connections":[{"id":"visible-connection","metadata":{"network":"tcp","sourceIP":"192.0.2.4","sourcePort":"5000","destinationIP":"198.51.100.2","destinationPort":"443","host":"example.org","process":"browser"},"upload":50,"download":100,"chains":["Proxy A","Group A"],"rule":"DOMAIN","rulePayload":"example.org"}]}`)
			} else {
				_, _ = io.WriteString(response, fmt.Sprintf(`{"downloadTotal":%d,"uploadTotal":%d,"connections":[]}`, 100+call*20, 50+call*10))
			}
		case "/version":
			_, _ = io.WriteString(response, `{"version":"test-mihomo"}`)
		case "/rules":
			_, _ = io.WriteString(response, `{"rules":[]}`)
		case "/providers/proxies":
			_, _ = io.WriteString(response, `{"providers":{}}`)
		case "/memory":
			_, _ = io.WriteString(response, `{"inuse":1048576}`+"\n")
		case "/logs":
			call := logCalls.Add(1)
			_, _ = io.WriteString(response, fmt.Sprintf(`{"type":"info","payload":"user-visible fake log %d"}`, call)+"\n")
		default:
			http.NotFound(response, request)
		}
	})}
	go func() { _ = fakeMihomo.Serve(listener) }()
	defer fakeMihomo.Close()

	service := &fakeService{running: true, errors: make(map[string]error)}
	opts := panel.DefaultOptions()
	opts.ConfigDir = directory
	opts.BaseConfig = filepath.Join(directory, "config.base.yaml")
	opts.EffectiveConfig = filepath.Join(directory, "config.yaml")
	opts.OverrideDir = filepath.Join(directory, "overrides")
	opts.StatsPath = filepath.Join(directory, "statistics.db")
	opts.RuntimeDir = filepath.Join(directory, "run")
	opts.ManagerSocket = filepath.Join(opts.RuntimeDir, "manager.sock")
	opts.ControllerSocket = socketPath
	opts.ConnectionInterval = 20 * time.Millisecond
	opts.Logger = log.New(io.Discard, "", 0)
	opts.Service = service
	opts.Validate = func(context.Context, string) error { return nil }
	opts.HealthCheck = func(context.Context) error { return nil }
	configuration := "mixed-port: 7890\nsecret: test-secret\nexternal-controller-unix: /run/mihomo/mihomo.sock\n"
	if err := os.WriteFile(opts.BaseConfig, []byte(configuration), 0o600); err != nil {
		t.Fatalf("seed authenticated base configuration: %v", err)
	}
	if err := os.WriteFile(opts.EffectiveConfig, []byte(configuration), 0o600); err != nil {
		t.Fatalf("seed authenticated effective configuration: %v", err)
	}

	app, err := panel.New(opts)
	if err != nil {
		t.Fatalf("create collecting panel: %v", err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	app.Start(ctx)
	server := httptest.NewServer(app.Handler())
	fixture := &apiFixture{t: t, dir: directory, opts: opts, app: app, server: server, service: service}

	deadline := time.Now().Add(2 * time.Second)
	for {
		_, historyEnvelope := fixture.request(http.MethodGet, "/api/history?range=1h&dimension=destination&limit=10", nil)
		history := dataObject(t, historyEnvelope)
		aggregates, _ := history["aggregates"].([]interface{})
		_, logsEnvelope := fixture.request(http.MethodGet, "/api/logs?cursor=0&limit=50&q=user-visible", nil)
		logs := dataObject(t, logsEnvelope)
		entries, _ := logs["entries"].([]interface{})
		if len(aggregates) > 0 && len(entries) > 0 {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("collector data did not become visible: history=%#v logs=%#v", history, logs)
		}
		time.Sleep(20 * time.Millisecond)
	}
	_, overviewEnvelope := fixture.request(http.MethodGet, "/api/overview?range=1h&history=0", nil)
	overview := dataObject(t, overviewEnvelope)
	if overview["serviceRunning"] != true {
		t.Fatalf("overview did not expose running state: %#v", overview)
	}
	if _, included := overview["history"]; included {
		t.Fatalf("lightweight live overview refresh unexpectedly included history: %#v", overview)
	}

	server.Close()
	cancel()
	if err := app.Close(); err != nil {
		t.Fatalf("close collecting panel: %v", err)
	}

	restarted, err := panel.New(opts)
	if err != nil {
		t.Fatalf("restart panel: %v", err)
	}
	restartedServer := httptest.NewServer(restarted.Handler())
	restartedFixture := &apiFixture{t: t, dir: directory, opts: opts, app: restarted, server: restartedServer, service: service}
	_, persistedEnvelope := restartedFixture.request(http.MethodGet, "/api/history?range=1h&dimension=destination&limit=10", nil)
	persisted := dataObject(t, persistedEnvelope)
	aggregates, _ := persisted["aggregates"].([]interface{})
	if len(aggregates) == 0 || !strings.Contains(fmt.Sprint(aggregates[0]), "example.org") {
		t.Fatalf("connection history did not survive restart: %#v", persisted)
	}
	_, pointsEnvelope := restartedFixture.request(http.MethodGet, "/api/history?range=1h", nil)
	points := dataObject(t, pointsEnvelope)["points"].([]interface{})
	if len(points) == 0 {
		t.Fatal("minute history did not survive restart")
	}
	if headers := unexpectedAuthorization.Load(); headers != 0 {
		t.Fatalf("Mihomo Unix socket requests sent an inapplicable Authorization header %d times", headers)
	}
	restartedServer.Close()
	if err := restarted.Close(); err != nil {
		t.Fatalf("close restarted panel: %v", err)
	}
}
