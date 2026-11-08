package log_test

import (
	"encoding/json"
	"fmt"
	"log/slog"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/TongTong313/merakcode/merak/engine/event"
	platformlog "github.com/TongTong313/merakcode/merak/internal/platform/log"
)

func TestLoggerWritesStructuredProcessDiagnostics(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "logs", "cli")
	logger, closeLog, err := platformlog.New(platformlog.Options{Dir: dir, Component: "cli", Level: slog.LevelInfo})
	if err != nil {
		t.Fatal(err)
	}
	logger.Info("command finished", "exitCode", 0)
	if err := closeLog(); err != nil {
		t.Fatal(err)
	}
	files, err := os.ReadDir(dir)
	if err != nil || len(files) != 1 {
		t.Fatalf("log files = %v, error = %v", files, err)
	}
	data, err := os.ReadFile(filepath.Join(dir, files[0].Name()))
	if err != nil {
		t.Fatal(err)
	}
	var record map[string]any
	if err := json.Unmarshal(data, &record); err != nil {
		t.Fatal(err)
	}
	if record["component"] != "cli" || record["level"] != "INFO" || record["msg"] != "command finished" || record["exitCode"] != float64(0) {
		t.Fatalf("unexpected diagnostic record: %s", data)
	}
}

func TestLoggerRotatesBoundedFilesAndKeepsTheNewestRecord(t *testing.T) {
	dir := t.TempDir()
	logger, closeLog, err := platformlog.New(platformlog.Options{Dir: dir, Component: "engine", MaxBytes: 400, MaxFiles: 5})
	if err != nil {
		t.Fatal(err)
	}
	for i := range 40 {
		logger.Info(fmt.Sprintf("record-%02d", i), "detail", strings.Repeat("x", 80))
	}
	if err := closeLog(); err != nil {
		t.Fatal(err)
	}
	files, err := os.ReadDir(dir)
	if err != nil || len(files) != 5 {
		t.Fatalf("files=%v error=%v", files, err)
	}
	found := false
	for _, file := range files {
		body, err := os.ReadFile(filepath.Join(dir, file.Name()))
		if err != nil {
			t.Fatal(err)
		}
		if len(body) > 400 {
			t.Fatalf("file exceeded its limit: %d", len(body))
		}
		for _, line := range strings.Split(strings.TrimSpace(string(body)), "\n") {
			if !json.Valid([]byte(line)) {
				t.Fatal("rotation split a record")
			}
		}
		found = found || strings.Contains(string(body), "record-39")
	}
	if !found {
		t.Fatal("rotation removed the newest record")
	}
}

func TestLoggerAddsScopeAndRedactsCredentialsAndConversationAttributes(t *testing.T) {
	dir := t.TempDir()
	logger, closeLog, err := platformlog.New(platformlog.Options{Dir: dir, Component: "engine"})
	if err != nil {
		t.Fatal(err)
	}
	key := "sk-" + strings.Repeat("a", 32)
	platformlog.With(logger, event.Scope{Session: "session", Group: "group", Task: "task"}).With("event", "event").Info("credential "+key,
		"token", "unstructured-sensitive-value", "prompt", "private conversation", "details", map[string]any{"password": "hidden", "safe": "visible"})
	if err := closeLog(); err != nil {
		t.Fatal(err)
	}
	files, err := os.ReadDir(dir)
	if err != nil || len(files) != 1 {
		t.Fatalf("files=%v error=%v", files, err)
	}
	body, err := os.ReadFile(filepath.Join(dir, files[0].Name()))
	if err != nil {
		t.Fatal(err)
	}
	for _, forbidden := range []string{key, "unstructured-sensitive-value", "private conversation", "hidden"} {
		if strings.Contains(string(body), forbidden) {
			t.Fatal("sensitive content entered the log")
		}
	}
	var record map[string]any
	if err := json.Unmarshal(body, &record); err != nil {
		t.Fatal(err)
	}
	for _, key := range []string{"session", "group", "task", "event"} {
		if record[key] != key {
			t.Fatalf("missing correlation field %s", key)
		}
	}
	if record["component"] != "engine" || record["msg"] != "credential [redacted]" || record["token"] != "[redacted]" || record["details"].(map[string]any)["safe"] != "visible" {
		t.Fatalf("record=%s", body)
	}
}

func TestLoggerRedactsGroupedAndNestedConversationFields(t *testing.T) {
	dir := t.TempDir()
	logger, closeLog, err := platformlog.New(platformlog.Options{Dir: dir, Component: "engine"})
	if err != nil {
		t.Fatal(err)
	}
	logger.WithGroup("environment").Info("configuration loaded", "CUSTOM_VALUE", "private-value")
	logger.Info("request completed", "details", map[string]any{"output": map[string]any{"text": "private-answer"}, "count": 1})
	if err := closeLog(); err != nil {
		t.Fatal(err)
	}
	files, err := os.ReadDir(dir)
	if err != nil {
		t.Fatal(err)
	}
	body, err := os.ReadFile(filepath.Join(dir, files[0].Name()))
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(body), "private-value") || strings.Contains(string(body), "private-answer") {
		t.Fatal("nested sensitive content entered the log")
	}
}

func TestLoggerReplacesOversizedRecordsAndContinuesWriting(t *testing.T) {
	dir := t.TempDir()
	logger, closeLog, err := platformlog.New(platformlog.Options{Dir: dir, Component: "engine", MaxBytes: 1024})
	if err != nil {
		t.Fatal(err)
	}
	logger.Info("large diagnostic", "detail", strings.Repeat("x", 4096))
	logger.Info("next record")
	if err := closeLog(); err != nil {
		t.Fatal(err)
	}
	files, err := os.ReadDir(dir)
	if err != nil {
		t.Fatal(err)
	}
	var messages []string
	for _, file := range files {
		body, err := os.ReadFile(filepath.Join(dir, file.Name()))
		if err != nil {
			t.Fatal(err)
		}
		if len(body) > 1024 {
			t.Fatalf("file exceeded its limit: %d", len(body))
		}
		for _, line := range strings.Split(strings.TrimSpace(string(body)), "\n") {
			var record map[string]any
			if err := json.Unmarshal([]byte(line), &record); err != nil {
				t.Fatal(err)
			}
			messages = append(messages, record["msg"].(string))
		}
	}
	if len(messages) != 2 || messages[0] != "Oversized log record omitted" || messages[1] != "next record" {
		t.Fatalf("messages=%v", messages)
	}
}
