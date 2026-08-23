package panel

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"time"
)

const defaultBaseConfiguration = `# Managed by luci-app-mihomo.
mixed-port: 7890
mode: rule
log-level: info
`

var overrideIDPattern = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$`)

type ConfigManager struct {
	opts    Options
	service Service
	mu      sync.Mutex
}

type configSnapshot struct {
	Base              string `json:"base"`
	Effective         string `json:"effective"`
	BaseRevision      string `json:"baseRevision"`
	EffectiveRevision string `json:"effectiveRevision"`
	ActiveRevision    string `json:"activeRevision"`
}

type overridesSnapshot struct {
	Draft          []OverrideItem `json:"draft"`
	Active         []OverrideItem `json:"active"`
	DraftRevision  string         `json:"draftRevision"`
	ActiveRevision string         `json:"activeRevision"`
	Changed        bool           `json:"changed"`
}

type previewResult struct {
	YAML            string `json:"yaml"`
	Digest          string `json:"digest"`
	DraftRevision   string `json:"draftRevision"`
	BaseRevision    string `json:"baseRevision"`
	ValidationReady bool   `json:"validationReady"`
}

type applyResult struct {
	BaseRevision      string `json:"baseRevision"`
	EffectiveRevision string `json:"effectiveRevision"`
	ActiveRevision    string `json:"activeRevision"`
	ServiceReloaded   bool   `json:"serviceReloaded"`
	ServiceWasRunning bool   `json:"serviceWasRunning"`
}

type fileChange struct {
	Path string
	Data []byte
}

type transactionRecord struct {
	Files []transactionFile `json:"files"`
}

type transactionFile struct {
	Path       string `json:"path"`
	BackupPath string `json:"backupPath"`
	Existed    bool   `json:"existed"`
}

func newConfigManager(opts Options) (*ConfigManager, error) {
	manager := &ConfigManager{opts: opts, service: opts.Service}
	if manager.service == nil {
		manager.service = &initService{script: opts.ServiceScript, controllerSocket: opts.ControllerSocket}
	}
	if err := manager.initialize(); err != nil {
		return nil, err
	}
	return manager, nil
}

func (manager *ConfigManager) initialize() error {
	if err := os.MkdirAll(manager.opts.ConfigDir, 0o700); err != nil {
		return fmt.Errorf("create Mihomo configuration directory: %w", err)
	}
	if err := os.MkdirAll(manager.opts.OverrideDir, 0o700); err != nil {
		return fmt.Errorf("create override directory: %w", err)
	}
	recovered, err := manager.recoverTransaction()
	if err != nil {
		return fmt.Errorf("recover interrupted configuration transaction: %w", err)
	}
	if recovered {
		ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		defer cancel()
		running, err := manager.service.Running(ctx)
		if err != nil {
			return fmt.Errorf("determine Mihomo state after transaction recovery: %w", err)
		}
		if running {
			if err := manager.service.Action(ctx, "restart"); err != nil {
				return fmt.Errorf("restart Mihomo after transaction recovery: %w", err)
			}
			if err := manager.waitHealthy(ctx); err != nil {
				return fmt.Errorf("Mihomo is unhealthy after transaction recovery: %w", err)
			}
		}
	}
	baseExists, err := fileExists(manager.opts.BaseConfig)
	if err != nil {
		return err
	}
	if !baseExists {
		effectiveExists, err := fileExists(manager.opts.EffectiveConfig)
		if err != nil {
			return err
		}
		if effectiveExists {
			if err := copyFile(manager.opts.EffectiveConfig, manager.opts.BaseConfig, 0o600); err != nil {
				return fmt.Errorf("adopt existing Mihomo configuration: %w", err)
			}
		} else if err := atomicWrite(manager.opts.BaseConfig, []byte(defaultBaseConfiguration), 0o600); err != nil {
			return fmt.Errorf("create base configuration: %w", err)
		}
	}
	for _, path := range []string{manager.draftPath(), manager.activePath()} {
		exists, err := fileExists(path)
		if err != nil {
			return err
		}
		if !exists {
			if err := atomicWrite(path, []byte("[]\n"), 0o600); err != nil {
				return fmt.Errorf("initialize overrides: %w", err)
			}
		}
	}
	base, err := readLimitedFile(manager.opts.BaseConfig, maxRequestBytes)
	if err != nil {
		return err
	}
	active, _, err := manager.loadItems(manager.activePath())
	if err != nil {
		return err
	}
	effective, err := mergeYAML(string(base), active)
	if err != nil {
		return err
	}
	effectiveExists, err := fileExists(manager.opts.EffectiveConfig)
	if err != nil {
		return err
	}
	if !effectiveExists {
		if err := atomicWrite(manager.opts.EffectiveConfig, effective, 0o600); err != nil {
			return err
		}
		return nil
	}
	current, err := readLimitedFile(manager.opts.EffectiveConfig, maxRequestBytes)
	if err != nil {
		return err
	}
	if bytes.Equal(current, effective) {
		return nil
	}
	ctx, cancel := context.WithTimeout(context.Background(), 90*time.Second)
	defer cancel()
	if err := manager.validate(ctx, effective); err != nil {
		return fmt.Errorf("validate reconciled effective configuration: %w", err)
	}
	if _, _, err := manager.commit(ctx, []fileChange{{Path: manager.opts.EffectiveConfig, Data: effective}}); err != nil {
		return fmt.Errorf("reconcile effective configuration: %w", err)
	}
	return nil
}

func (manager *ConfigManager) Config() (configSnapshot, error) {
	manager.mu.Lock()
	defer manager.mu.Unlock()
	base, err := readLimitedFile(manager.opts.BaseConfig, maxRequestBytes)
	if err != nil {
		return configSnapshot{}, err
	}
	effective, err := readLimitedFile(manager.opts.EffectiveConfig, maxRequestBytes)
	if err != nil {
		return configSnapshot{}, err
	}
	_, activeRevision, err := manager.loadItems(manager.activePath())
	if err != nil {
		return configSnapshot{}, err
	}
	return configSnapshot{
		Base:              string(base),
		Effective:         string(effective),
		BaseRevision:      revision(base),
		EffectiveRevision: revision(effective),
		ActiveRevision:    activeRevision,
	}, nil
}

func (manager *ConfigManager) ApplyBase(ctx context.Context, content, expectedRevision string) (applyResult, error) {
	manager.mu.Lock()
	defer manager.mu.Unlock()
	if len(content) > maxRequestBytes {
		return applyResult{}, apiError(413, "configuration_too_large", "Configuration exceeds 4 MiB", nil)
	}
	current, err := readLimitedFile(manager.opts.BaseConfig, maxRequestBytes)
	if err != nil {
		return applyResult{}, err
	}
	if revision(current) != expectedRevision {
		return applyResult{}, apiError(409, "revision_conflict", "The base configuration changed; reload it before applying", map[string]string{"currentRevision": revision(current)})
	}
	active, activeRevision, err := manager.loadItems(manager.activePath())
	if err != nil {
		return applyResult{}, err
	}
	effective, err := mergeYAML(content, active)
	if err != nil {
		return applyResult{}, apiError(422, "invalid_yaml", err.Error(), nil)
	}
	if err := manager.validate(ctx, effective); err != nil {
		return applyResult{}, err
	}
	reloaded, running, err := manager.commit(ctx, []fileChange{
		{Path: manager.opts.BaseConfig, Data: []byte(content)},
		{Path: manager.opts.EffectiveConfig, Data: effective},
	})
	if err != nil {
		return applyResult{}, err
	}
	return applyResult{
		BaseRevision: revision([]byte(content)), EffectiveRevision: revision(effective),
		ActiveRevision: activeRevision, ServiceReloaded: reloaded, ServiceWasRunning: running,
	}, nil
}

func (manager *ConfigManager) Overrides() (overridesSnapshot, error) {
	manager.mu.Lock()
	defer manager.mu.Unlock()
	draft, draftRevision, err := manager.loadItems(manager.draftPath())
	if err != nil {
		return overridesSnapshot{}, err
	}
	active, activeRevision, err := manager.loadItems(manager.activePath())
	if err != nil {
		return overridesSnapshot{}, err
	}
	return overridesSnapshot{Draft: draft, Active: active, DraftRevision: draftRevision, ActiveRevision: activeRevision, Changed: draftRevision != activeRevision}, nil
}

func (manager *ConfigManager) SaveDraft(items []OverrideItem, expectedRevision string) (overridesSnapshot, error) {
	manager.mu.Lock()
	defer manager.mu.Unlock()
	_, currentRevision, err := manager.loadItems(manager.draftPath())
	if err != nil {
		return overridesSnapshot{}, err
	}
	if currentRevision != expectedRevision {
		return overridesSnapshot{}, apiError(409, "revision_conflict", "The override draft changed; reload it before saving", map[string]string{"currentRevision": currentRevision})
	}
	items, err = normalizeOverrideItems(items)
	if err != nil {
		return overridesSnapshot{}, apiError(422, "invalid_overrides", err.Error(), nil)
	}
	data, err := marshalItems(items)
	if err != nil {
		return overridesSnapshot{}, err
	}
	if len(data) > maxRequestBytes {
		return overridesSnapshot{}, apiError(413, "overrides_too_large", "Override draft exceeds 4 MiB", nil)
	}
	if err := atomicWrite(manager.draftPath(), data, 0o600); err != nil {
		return overridesSnapshot{}, err
	}
	active, activeRevision, err := manager.loadItems(manager.activePath())
	if err != nil {
		return overridesSnapshot{}, err
	}
	return overridesSnapshot{Draft: items, Active: active, DraftRevision: revision(data), ActiveRevision: activeRevision, Changed: revision(data) != activeRevision}, nil
}

func (manager *ConfigManager) Preview(expectedDraftRevision string) (previewResult, error) {
	manager.mu.Lock()
	defer manager.mu.Unlock()
	base, err := readLimitedFile(manager.opts.BaseConfig, maxRequestBytes)
	if err != nil {
		return previewResult{}, err
	}
	draft, draftRevision, err := manager.loadItems(manager.draftPath())
	if err != nil {
		return previewResult{}, err
	}
	if draftRevision != expectedDraftRevision {
		return previewResult{}, apiError(409, "revision_conflict", "The override draft changed; preview it again", map[string]string{"currentRevision": draftRevision})
	}
	effective, err := mergeYAML(string(base), draft)
	if err != nil {
		return previewResult{}, apiError(422, "invalid_yaml", err.Error(), nil)
	}
	baseRevision := revision(base)
	return previewResult{YAML: string(effective), Digest: previewRevision(baseRevision, draftRevision, effective), DraftRevision: draftRevision, BaseRevision: baseRevision, ValidationReady: true}, nil
}

func (manager *ConfigManager) ApplyOverrides(ctx context.Context, expectedDraftRevision, expectedDigest string) (applyResult, error) {
	manager.mu.Lock()
	defer manager.mu.Unlock()
	base, err := readLimitedFile(manager.opts.BaseConfig, maxRequestBytes)
	if err != nil {
		return applyResult{}, err
	}
	draft, draftRevision, err := manager.loadItems(manager.draftPath())
	if err != nil {
		return applyResult{}, err
	}
	if draftRevision != expectedDraftRevision {
		return applyResult{}, apiError(409, "revision_conflict", "The override draft changed; preview it again", map[string]string{"currentRevision": draftRevision})
	}
	effective, err := mergeYAML(string(base), draft)
	if err != nil {
		return applyResult{}, apiError(422, "invalid_yaml", err.Error(), nil)
	}
	digest := previewRevision(revision(base), draftRevision, effective)
	if expectedDigest == "" || digest != expectedDigest {
		return applyResult{}, apiError(409, "preview_stale", "The preview is stale; generate a new preview before applying", map[string]string{"currentDigest": digest})
	}
	if err := manager.validate(ctx, effective); err != nil {
		return applyResult{}, err
	}
	draftData, err := marshalItems(draft)
	if err != nil {
		return applyResult{}, err
	}
	reloaded, running, err := manager.commit(ctx, []fileChange{
		{Path: manager.activePath(), Data: draftData},
		{Path: manager.opts.EffectiveConfig, Data: effective},
	})
	if err != nil {
		return applyResult{}, err
	}
	return applyResult{BaseRevision: revision(base), EffectiveRevision: revision(effective), ActiveRevision: revision(draftData), ServiceReloaded: reloaded, ServiceWasRunning: running}, nil
}

func (manager *ConfigManager) validate(ctx context.Context, effective []byte) error {
	path := "/tmp/mihomo-config.yaml.new"
	_ = os.Remove(path)
	file, err := os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600)
	if err != nil {
		return apiError(500, "validation_staging_failed", "Could not stage the configuration for validation", err.Error())
	}
	if _, err = file.Write(effective); err == nil {
		err = file.Sync()
	}
	closeErr := file.Close()
	if err == nil {
		err = closeErr
	}
	if err != nil {
		_ = os.Remove(path)
		return apiError(500, "validation_staging_failed", "Could not stage the configuration for validation", err.Error())
	}
	defer os.Remove(path)
	validate := manager.opts.Validate
	if validate == nil {
		validate = func(ctx context.Context, candidate string) error {
			validationCtx, cancel := context.WithTimeout(ctx, 60*time.Second)
			defer cancel()
			message, err := runCappedCommand(validationCtx, manager.opts.MihomoBinary, []string{"-t", "-d", manager.opts.ConfigDir, "-f", candidate}, 32<<10)
			if err == nil {
				return nil
			}
			if message == "" {
				message = err.Error()
			}
			return errors.New(message)
		}
	}
	if err := validate(ctx, path); err != nil {
		return apiError(422, "mihomo_validation_failed", "Mihomo rejected the configuration", err.Error())
	}
	return nil
}

func (manager *ConfigManager) commit(ctx context.Context, changes []fileChange) (bool, bool, error) {
	running, err := manager.service.Running(ctx)
	if err != nil {
		return false, false, apiError(502, "service_state_failed", "Could not determine Mihomo service state", err.Error())
	}
	record, err := manager.beginTransaction(changes)
	if err != nil {
		return false, running, apiError(500, "transaction_failed", "Could not prepare the configuration transaction", err.Error())
	}
	for _, change := range changes {
		if err := atomicWrite(change.Path, change.Data, 0o600); err != nil {
			_ = manager.restoreTransaction(record)
			return false, running, apiError(500, "configuration_write_failed", "Could not atomically replace the configuration", err.Error())
		}
	}
	if !running {
		if err := manager.finishTransaction(record); err != nil {
			restoreError := manager.restoreTransaction(record)
			details := map[string]interface{}{"cause": err.Error(), "rolledBack": restoreError == nil}
			if restoreError != nil {
				details["rollbackError"] = restoreError.Error()
			}
			return false, false, apiError(500, "transaction_finalize_failed", "Could not safely commit the configuration transaction", details)
		}
		return false, false, nil
	}
	if err := manager.service.Action(ctx, "reload"); err != nil {
		return false, true, manager.rollbackAfterReload(ctx, record, "Mihomo reload failed", err)
	}
	if err := manager.waitHealthy(ctx); err != nil {
		return false, true, manager.rollbackAfterReload(ctx, record, "Mihomo did not become healthy after reload", err)
	}
	if err := manager.finishTransaction(record); err != nil {
		return false, true, manager.rollbackAfterReload(ctx, record, "Could not safely commit the configuration transaction", err)
	}
	return true, true, nil
}

func (manager *ConfigManager) waitHealthy(ctx context.Context) error {
	health := manager.opts.HealthCheck
	if health == nil {
		return nil
	}
	deadline := time.Now().Add(manager.opts.HealthTimeout)
	var lastError error
	for {
		probeCtx, cancel := context.WithTimeout(ctx, time.Second)
		lastError = health(probeCtx)
		cancel()
		if lastError == nil {
			return nil
		}
		if time.Now().After(deadline) {
			return lastError
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(250 * time.Millisecond):
		}
	}
}

func (manager *ConfigManager) rollbackAfterReload(ctx context.Context, record transactionRecord, message string, cause error) error {
	restoreError := manager.restoreTransaction(record)
	recoveryCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 30*time.Second)
	defer cancel()
	restartError := manager.service.Action(recoveryCtx, "restart")
	details := map[string]interface{}{"cause": cause.Error(), "rolledBack": restoreError == nil, "oldServiceRestarted": restartError == nil}
	if restoreError != nil {
		details["rollbackError"] = restoreError.Error()
	}
	if restartError != nil {
		details["restartError"] = restartError.Error()
	}
	return apiError(502, "reload_rolled_back", message+"; the previous configuration was restored", details)
}

func (manager *ConfigManager) beginTransaction(changes []fileChange) (transactionRecord, error) {
	record := transactionRecord{}
	complete := false
	defer func() {
		if complete {
			return
		}
		for _, entry := range record.Files {
			_ = os.Remove(entry.BackupPath)
		}
	}()
	for index, change := range changes {
		existed, err := fileExists(change.Path)
		if err != nil {
			return record, err
		}
		entry := transactionFile{Path: change.Path, Existed: existed, BackupPath: fmt.Sprintf("%s.backup-%d", manager.transactionPath(), index)}
		record.Files = append(record.Files, entry)
		if existed {
			if err := copyFile(change.Path, entry.BackupPath, 0o600); err != nil {
				return record, err
			}
		}
	}
	data, err := json.Marshal(record)
	if err != nil {
		return record, err
	}
	if err := atomicWrite(manager.transactionPath(), append(data, '\n'), 0o600); err != nil {
		return record, err
	}
	complete = true
	return record, nil
}

func (manager *ConfigManager) restoreTransaction(record transactionRecord) error {
	var failures []string
	for _, entry := range record.Files {
		if entry.Existed {
			if err := copyFile(entry.BackupPath, entry.Path, 0o600); err != nil {
				failures = append(failures, fmt.Sprintf("%s: %v", entry.Path, err))
			}
		} else if err := os.Remove(entry.Path); err != nil && !errors.Is(err, os.ErrNotExist) {
			failures = append(failures, fmt.Sprintf("%s: %v", entry.Path, err))
		}
	}
	if len(failures) > 0 {
		return errors.New(strings.Join(failures, "; "))
	}
	return manager.finishTransaction(record)
}

func (manager *ConfigManager) recoverTransaction() (bool, error) {
	data, err := os.ReadFile(manager.transactionPath())
	if errors.Is(err, os.ErrNotExist) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	var record transactionRecord
	if err := json.Unmarshal(data, &record); err != nil {
		return false, err
	}
	return true, manager.restoreTransaction(record)
}

func (manager *ConfigManager) finishTransaction(record transactionRecord) error {
	if err := os.Remove(manager.transactionPath()); err != nil && !errors.Is(err, os.ErrNotExist) {
		return err
	}
	if err := syncDirectory(manager.opts.ConfigDir); err != nil {
		return err
	}
	for _, entry := range record.Files {
		_ = os.Remove(entry.BackupPath)
	}
	_ = syncDirectory(manager.opts.ConfigDir)
	return nil
}

func (manager *ConfigManager) loadItems(path string) ([]OverrideItem, string, error) {
	data, err := readLimitedFile(path, maxRequestBytes)
	if err != nil {
		return nil, "", err
	}
	var items []OverrideItem
	if err := json.Unmarshal(data, &items); err != nil {
		return nil, "", fmt.Errorf("decode %s: %w", path, err)
	}
	if items == nil {
		items = []OverrideItem{}
	}
	canonical, err := marshalItems(items)
	if err != nil {
		return nil, "", err
	}
	return items, revision(canonical), nil
}

func normalizeOverrideItems(items []OverrideItem) ([]OverrideItem, error) {
	if len(items) > 128 {
		return nil, fmt.Errorf("at most 128 overrides are allowed")
	}
	seen := make(map[string]struct{}, len(items))
	result := make([]OverrideItem, len(items))
	for index, item := range items {
		item.Name = strings.TrimSpace(item.Name)
		if item.ID == "" {
			var random [8]byte
			if _, err := rand.Read(random[:]); err != nil {
				return nil, err
			}
			item.ID = hex.EncodeToString(random[:])
		}
		if !overrideIDPattern.MatchString(item.ID) {
			return nil, fmt.Errorf("override %d has an invalid ID", index+1)
		}
		if _, exists := seen[item.ID]; exists {
			return nil, fmt.Errorf("override ID %q is duplicated", item.ID)
		}
		seen[item.ID] = struct{}{}
		if item.Name == "" {
			item.Name = fmt.Sprintf("Override %d", index+1)
		}
		if len(item.Name) > 128 {
			return nil, fmt.Errorf("override %d name is too long", index+1)
		}
		if len(item.Content) > 1<<20 {
			return nil, fmt.Errorf("override %d exceeds 1 MiB", index+1)
		}
		if item.Enabled {
			if _, err := parseYAMLDocument([]byte(item.Content), item.Name); err != nil {
				return nil, err
			}
		}
		result[index] = item
	}
	return result, nil
}

func marshalItems(items []OverrideItem) ([]byte, error) {
	if items == nil {
		items = []OverrideItem{}
	}
	data, err := json.MarshalIndent(items, "", "  ")
	if err != nil {
		return nil, err
	}
	return append(data, '\n'), nil
}

func (manager *ConfigManager) draftPath() string {
	return filepath.Join(manager.opts.OverrideDir, "draft.json")
}
func (manager *ConfigManager) activePath() string {
	return filepath.Join(manager.opts.OverrideDir, "active.json")
}
func (manager *ConfigManager) transactionPath() string {
	return filepath.Join(manager.opts.ConfigDir, ".luci-mihomo-transaction.json")
}
