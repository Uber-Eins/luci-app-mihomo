package panel

import (
	"strings"
	"sync"
	"time"
)

type logRing struct {
	mu       sync.RWMutex
	entries  []LogEntry
	next     uint64
	bytes    int
	maxItems int
	maxBytes int
}

func newLogRing(maxItems, maxBytes int) *logRing {
	return &logRing{next: 1, maxItems: maxItems, maxBytes: maxBytes}
}

func (ring *logRing) Add(level, message string) {
	message = strings.TrimSpace(message)
	if message == "" {
		return
	}
	if len(message) > 64<<10 {
		message = message[:64<<10]
	}
	ring.mu.Lock()
	defer ring.mu.Unlock()
	entry := LogEntry{Sequence: ring.next, Time: time.Now(), Level: strings.ToLower(strings.TrimSpace(level)), Message: message}
	if entry.Level == "" {
		entry.Level = "info"
	}
	ring.next++
	ring.entries = append(ring.entries, entry)
	ring.bytes += len(entry.Message)
	for len(ring.entries) > ring.maxItems || (ring.bytes > ring.maxBytes && len(ring.entries) > 1) {
		ring.bytes -= len(ring.entries[0].Message)
		ring.entries[0] = LogEntry{}
		ring.entries = ring.entries[1:]
	}
}

func (ring *logRing) Query(cursor uint64, limit int, level, search string) ([]LogEntry, uint64) {
	if limit < 1 || limit > 1000 {
		limit = 300
	}
	level = strings.ToLower(strings.TrimSpace(level))
	search = strings.ToLower(strings.TrimSpace(search))
	ring.mu.RLock()
	defer ring.mu.RUnlock()
	result := make([]LogEntry, 0, limit)
	for _, entry := range ring.entries {
		if entry.Sequence <= cursor {
			continue
		}
		if level != "" && level != "all" && entry.Level != level {
			continue
		}
		if search != "" && !strings.Contains(strings.ToLower(entry.Message), search) {
			continue
		}
		result = append(result, entry)
		if len(result) >= limit {
			break
		}
	}
	latest := cursor
	if len(result) > 0 {
		latest = result[len(result)-1].Sequence
	} else if ring.next > 1 {
		latest = ring.next - 1
	}
	return result, latest
}
