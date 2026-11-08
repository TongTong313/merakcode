package log

import (
	"encoding/json"
	"fmt"
	"os"
	"strings"
	"sync"
)

type rotating struct {
	mu             sync.Mutex
	file           *os.File
	path           string
	size, maxBytes int64
	maxFiles       int
}

func (w *rotating) name(index int) string {
	if index == 0 {
		return w.path
	}
	return fmt.Sprintf("%s.%d.ndjson", strings.TrimSuffix(w.path, ".ndjson"), index)
}

func (w *rotating) Write(data []byte) (int, error) {
	w.mu.Lock()
	defer w.mu.Unlock()
	if w.file == nil {
		return 0, os.ErrClosed
	}
	inputSize := len(data)
	if int64(inputSize) > w.maxBytes {
		var fields map[string]any
		_ = json.Unmarshal(data, &fields)
		record := map[string]any{"level": "WARN", "msg": "Oversized log record omitted"}
		for _, key := range []string{"time", "component", "session", "group", "task", "event"} {
			value, _ := fields[key].(string)
			if len(value) > 64 {
				value = ""
			}
			record[key] = value
		}
		data, _ = json.Marshal(record)
		data = append(data, '\n')
		if int64(len(data)) > w.maxBytes {
			return 0, fmt.Errorf("log record limit is too small for diagnostic metadata")
		}
	}
	if w.size > 0 && w.size+int64(len(data)) > w.maxBytes {
		if err := w.file.Close(); err != nil {
			return 0, err
		}
		w.file = nil
		if err := os.Remove(w.name(w.maxFiles - 1)); err != nil && !os.IsNotExist(err) {
			return 0, err
		}
		for i := w.maxFiles - 2; i >= 0; i-- {
			if err := os.Rename(w.name(i), w.name(i+1)); err != nil && !os.IsNotExist(err) {
				return 0, err
			}
		}
		file, err := os.OpenFile(w.path, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0600)
		if err != nil {
			return 0, err
		}
		w.file = file
		w.size = 0
	}
	count, err := w.file.Write(data)
	w.size += int64(count)
	if err != nil {
		return 0, err
	}
	return inputSize, nil
}

func (w *rotating) Close() error {
	w.mu.Lock()
	defer w.mu.Unlock()
	if w.file == nil {
		return nil
	}
	err := w.file.Close()
	w.file = nil
	return err
}
