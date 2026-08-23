package panel

import (
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"sort"
	"strings"
	"sync"
	"time"
	"unicode/utf8"

	bolt "go.etcd.io/bbolt"
)

var (
	minuteBucket = []byte("minutes-v1")
	dailyBucket  = []byte("daily-v1")
)

type minuteAccumulator struct {
	Upload      float64
	Download    float64
	Memory      float64
	Connections float64
	Samples     uint64
}

type aggregateKey struct {
	Day       string
	Dimension string
	Key       string
}

type StatsStore struct {
	mu             sync.RWMutex
	db             *bolt.DB
	retention      time.Duration
	pendingMinutes map[int64]*minuteAccumulator
	pendingDaily   map[aggregateKey]*Aggregate
	closed         bool
}

func openStats(path string, retention time.Duration) (*StatsStore, error) {
	db, err := bolt.Open(path, 0o600, &bolt.Options{Timeout: 2 * time.Second, NoFreelistSync: true})
	if err != nil {
		return nil, err
	}
	store := &StatsStore{
		db: db, retention: retention,
		pendingMinutes: make(map[int64]*minuteAccumulator),
		pendingDaily:   make(map[aggregateKey]*Aggregate),
	}
	if err := db.Update(func(tx *bolt.Tx) error {
		if _, err := tx.CreateBucketIfNotExists(minuteBucket); err != nil {
			return err
		}
		_, err := tx.CreateBucketIfNotExists(dailyBucket)
		return err
	}); err != nil {
		_ = db.Close()
		return nil, err
	}
	return store, nil
}

func (store *StatsStore) RecordSample(at time.Time, upload, download, memory float64, connections int) {
	minute := at.Truncate(time.Minute).Unix()
	store.mu.Lock()
	defer store.mu.Unlock()
	if store.closed {
		return
	}
	value := store.pendingMinutes[minute]
	if value == nil {
		value = &minuteAccumulator{}
		store.pendingMinutes[minute] = value
	}
	value.Upload += upload
	value.Download += download
	value.Memory += memory
	value.Connections += float64(connections)
	value.Samples++
}

func (store *StatsStore) RecordClosed(at time.Time, dimensions map[string]string, upload, download uint64) {
	day := at.Format("2006-01-02")
	store.mu.Lock()
	defer store.mu.Unlock()
	if store.closed {
		return
	}
	for dimension, value := range dimensions {
		value = boundedDimensionValue(value)
		if value == "" {
			value = "Unknown"
		}
		key := aggregateKey{Day: day, Dimension: dimension, Key: value}
		if len(store.pendingDaily) > 4096 {
			key.Key = "Other"
		}
		aggregate := store.pendingDaily[key]
		if aggregate == nil {
			aggregate = &Aggregate{Key: key.Key}
			store.pendingDaily[key] = aggregate
		}
		aggregate.Count++
		aggregate.Upload += upload
		aggregate.Download += download
	}
}

func boundedDimensionValue(value string) string {
	value = strings.TrimSpace(strings.ToValidUTF8(value, "�"))
	const maxBytes = 512
	if len(value) <= maxBytes {
		return value
	}
	end := maxBytes - len("…")
	for end > 0 && !utf8.ValidString(value[:end]) {
		end--
	}
	return value[:end] + "…"
}

func (store *StatsStore) Flush() error {
	store.mu.Lock()
	defer store.mu.Unlock()
	if store.closed {
		return nil
	}
	return store.flushLocked(time.Now())
}

func (store *StatsStore) flushLocked(now time.Time) error {
	minutes := store.pendingMinutes
	daily := store.pendingDaily
	store.pendingMinutes = make(map[int64]*minuteAccumulator)
	store.pendingDaily = make(map[aggregateKey]*Aggregate)
	err := store.db.Update(func(tx *bolt.Tx) error {
		minuteValues := tx.Bucket(minuteBucket)
		for timestamp, accumulator := range minutes {
			point := pointFromAccumulator(timestamp, accumulator)
			data, err := json.Marshal(point)
			if err != nil {
				return err
			}
			if err := minuteValues.Put(timestampKey(timestamp), data); err != nil {
				return err
			}
		}
		dailyValues := tx.Bucket(dailyBucket)
		counts := make(map[string]int)
		for key, addition := range daily {
			storageKey := dailyKey(key.Day, key.Dimension, key.Key)
			current := Aggregate{Key: key.Key}
			if data := dailyValues.Get(storageKey); data != nil {
				if err := json.Unmarshal(data, &current); err != nil {
					return err
				}
			} else if key.Key != "Other" {
				prefix := key.Day + "\x00" + key.Dimension + "\x00"
				count, known := counts[prefix]
				if !known {
					count = countPrefix(dailyValues, []byte(prefix))
				}
				if count >= 512 {
					storageKey = dailyKey(key.Day, key.Dimension, "Other")
					current = Aggregate{Key: "Other"}
					if data := dailyValues.Get(storageKey); data != nil {
						if err := json.Unmarshal(data, &current); err != nil {
							return err
						}
					}
				} else {
					counts[prefix] = count + 1
				}
			}
			current.Count += addition.Count
			current.Upload += addition.Upload
			current.Download += addition.Download
			data, err := json.Marshal(current)
			if err != nil {
				return err
			}
			if err := dailyValues.Put(storageKey, data); err != nil {
				return err
			}
		}
		return pruneStats(tx, now.Add(-store.retention))
	})
	if err != nil {
		for key, value := range minutes {
			mergeMinute(store.pendingMinutes, key, value)
		}
		for key, value := range daily {
			mergeAggregate(store.pendingDaily, key, value)
		}
	}
	return err
}

func (store *StatsStore) History(since time.Time) ([]HistoryPoint, error) {
	store.mu.RLock()
	defer store.mu.RUnlock()
	if store.closed {
		return nil, errors.New("statistics store is closed")
	}
	points := make(map[int64]HistoryPoint)
	err := store.db.View(func(tx *bolt.Tx) error {
		bucket := tx.Bucket(minuteBucket)
		cursor := bucket.Cursor()
		for key, value := cursor.Seek(timestampKey(since.Unix())); key != nil; key, value = cursor.Next() {
			var point HistoryPoint
			if err := json.Unmarshal(value, &point); err != nil {
				return err
			}
			points[point.Timestamp] = point
		}
		return nil
	})
	if err != nil {
		return nil, err
	}
	for timestamp, accumulator := range store.pendingMinutes {
		if timestamp >= since.Unix() {
			points[timestamp] = pointFromAccumulator(timestamp, accumulator)
		}
	}
	result := make([]HistoryPoint, 0, len(points))
	for _, point := range points {
		result = append(result, point)
	}
	sort.Slice(result, func(i, j int) bool { return result[i].Timestamp < result[j].Timestamp })
	return result, nil
}

func (store *StatsStore) Aggregates(since time.Time, dimension string, limit int) ([]Aggregate, error) {
	if !validDimension(dimension) {
		return nil, apiError(400, "invalid_dimension", "Unsupported history dimension", nil)
	}
	if limit < 1 || limit > 100 {
		limit = 20
	}
	store.mu.RLock()
	defer store.mu.RUnlock()
	combined := make(map[string]*Aggregate)
	err := store.db.View(func(tx *bolt.Tx) error {
		bucket := tx.Bucket(dailyBucket)
		cursor := bucket.Cursor()
		startDay := since.Format("2006-01-02")
		for key, value := cursor.Seek([]byte(startDay)); key != nil; key, value = cursor.Next() {
			parts := strings.SplitN(string(key), "\x00", 3)
			if len(parts) != 3 || parts[0] < startDay || parts[1] != dimension {
				continue
			}
			var aggregate Aggregate
			if err := json.Unmarshal(value, &aggregate); err != nil {
				return err
			}
			mergeAggregateValue(combined, aggregate)
		}
		return nil
	})
	if err != nil {
		return nil, err
	}
	startDay := since.Format("2006-01-02")
	for key, aggregate := range store.pendingDaily {
		if key.Day >= startDay && key.Dimension == dimension {
			mergeAggregateValue(combined, *aggregate)
		}
	}
	result := make([]Aggregate, 0, len(combined))
	for _, aggregate := range combined {
		result = append(result, *aggregate)
	}
	sort.Slice(result, func(i, j int) bool {
		left := result[i].Upload + result[i].Download
		right := result[j].Upload + result[j].Download
		if left == right {
			return result[i].Count > result[j].Count
		}
		return left > right
	})
	if len(result) > limit {
		result = result[:limit]
	}
	return result, nil
}

func (store *StatsStore) Clear() error {
	store.mu.Lock()
	defer store.mu.Unlock()
	if store.closed {
		return errors.New("statistics store is closed")
	}
	store.pendingMinutes = make(map[int64]*minuteAccumulator)
	store.pendingDaily = make(map[aggregateKey]*Aggregate)
	return store.db.Update(func(tx *bolt.Tx) error {
		if err := tx.DeleteBucket(minuteBucket); err != nil && !errors.Is(err, bolt.ErrBucketNotFound) {
			return err
		}
		if err := tx.DeleteBucket(dailyBucket); err != nil && !errors.Is(err, bolt.ErrBucketNotFound) {
			return err
		}
		if _, err := tx.CreateBucket(minuteBucket); err != nil {
			return err
		}
		_, err := tx.CreateBucket(dailyBucket)
		return err
	})
}

func (store *StatsStore) Close() error {
	store.mu.Lock()
	defer store.mu.Unlock()
	if store.closed {
		return nil
	}
	flushError := store.flushLocked(time.Now())
	store.closed = true
	closeError := store.db.Close()
	if flushError != nil {
		return flushError
	}
	return closeError
}

func pruneStats(tx *bolt.Tx, cutoff time.Time) error {
	minuteValues := tx.Bucket(minuteBucket)
	minCursor := minuteValues.Cursor()
	cutoffTimestamp := cutoff.Unix()
	for key, _ := minCursor.First(); key != nil; key, _ = minCursor.Next() {
		if int64(binary.BigEndian.Uint64(key)) >= cutoffTimestamp {
			break
		}
		if err := minCursor.Delete(); err != nil {
			return err
		}
	}
	dailyValues := tx.Bucket(dailyBucket)
	dailyCursor := dailyValues.Cursor()
	cutoffDay := cutoff.Format("2006-01-02")
	for key, _ := dailyCursor.First(); key != nil; key, _ = dailyCursor.Next() {
		if len(key) >= 10 && string(key[:10]) >= cutoffDay {
			break
		}
		if err := dailyCursor.Delete(); err != nil {
			return err
		}
	}
	return nil
}

func pointFromAccumulator(timestamp int64, accumulator *minuteAccumulator) HistoryPoint {
	if accumulator == nil || accumulator.Samples == 0 {
		return HistoryPoint{Timestamp: timestamp}
	}
	divisor := float64(accumulator.Samples)
	return HistoryPoint{Timestamp: timestamp, Upload: accumulator.Upload / divisor, Download: accumulator.Download / divisor, Memory: accumulator.Memory / divisor, Connections: accumulator.Connections / divisor}
}

func timestampKey(timestamp int64) []byte {
	key := make([]byte, 8)
	binary.BigEndian.PutUint64(key, uint64(timestamp))
	return key
}

func dailyKey(day, dimension, key string) []byte {
	return []byte(day + "\x00" + dimension + "\x00" + key)
}

func countPrefix(bucket *bolt.Bucket, prefix []byte) int {
	count := 0
	cursor := bucket.Cursor()
	for key, _ := cursor.Seek(prefix); key != nil && strings.HasPrefix(string(key), string(prefix)); key, _ = cursor.Next() {
		count++
	}
	return count
}

func mergeMinute(target map[int64]*minuteAccumulator, key int64, value *minuteAccumulator) {
	current := target[key]
	if current == nil {
		copy := *value
		target[key] = &copy
		return
	}
	current.Upload += value.Upload
	current.Download += value.Download
	current.Memory += value.Memory
	current.Connections += value.Connections
	current.Samples += value.Samples
}

func mergeAggregate(target map[aggregateKey]*Aggregate, key aggregateKey, value *Aggregate) {
	current := target[key]
	if current == nil {
		copy := *value
		target[key] = &copy
		return
	}
	current.Count += value.Count
	current.Upload += value.Upload
	current.Download += value.Download
}

func mergeAggregateValue(target map[string]*Aggregate, value Aggregate) {
	current := target[value.Key]
	if current == nil {
		copy := value
		target[value.Key] = &copy
		return
	}
	current.Count += value.Count
	current.Upload += value.Upload
	current.Download += value.Download
}

func validDimension(dimension string) bool {
	switch dimension {
	case "source_ip", "destination", "process", "outbound", "proxy_group", "rule":
		return true
	default:
		return false
	}
}

func (store *StatsStore) String() string {
	return fmt.Sprintf("StatsStore(retention=%s)", store.retention)
}
