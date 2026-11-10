package diagnose_test

import (
	"archive/zip"
	"bytes"
	"context"
	"encoding/json"
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/TongTong313/merakcode/merak/engine/event"
	storage "github.com/TongTong313/merakcode/merak/engine/store/memory"
	"github.com/TongTong313/merakcode/merak/internal/diagnose"
)

func TestBundleIncludesRedactedRecentLogsAndOnlyExplicitSessionEvents(t *testing.T) {
	ctx := context.Background()
	home, logs := t.TempDir(), t.TempDir()
	now := time.Date(2026, 11, 8, 12, 0, 0, 0, time.UTC)
	for _, file := range []struct {
		path, body string
		age        time.Duration
	}{
		{filepath.Join(home, "engine.json"), `{"endpoint":"ws://127.0.0.1:1234/rpc","token":"private-connection-token","pid":123,"unknown":"private-connection-content"}`, 0},
		{filepath.Join(logs, "production", "engine", "recent.ndjson"), `{"msg":"ready","token":"private-log-token","prompt":"private-conversation"}` + "\n", time.Hour},
		{filepath.Join(logs, "production", "engine", "old.ndjson"), `{"msg":"too old"}` + "\n", 4 * 24 * time.Hour},
	} {
		if err := os.MkdirAll(filepath.Dir(file.path), 0700); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(file.path, []byte(file.body), 0600); err != nil {
			t.Fatal(err)
		}
		stamp := now.Add(-file.age)
		if err := os.Chtimes(file.path, stamp, stamp); err != nil {
			t.Fatal(err)
		}
	}
	durable := storage.New()
	for _, id := range []event.ID{"selected", "other"} {
		body, _ := json.Marshal(map[string]string{"text": "conversation-" + string(id), "token": "private-event-token"})
		if err := durable.Append(ctx, []event.Event{{ID: id, Stream: event.Stream("session:" + id), Seq: 1, Time: now, Type: "message.sent", Scope: event.Scope{Session: id}, Payload: body}}); err != nil {
			t.Fatal(err)
		}
	}
	bundler := diagnose.Bundler{DataDir: home, LogRoot: logs, Now: func() time.Time { return now }, Find: durable.Find}
	for _, selected := range []event.ID{"", "selected"} {
		var output bytes.Buffer
		if err := bundler.Bundle(ctx, diagnose.Request{Session: selected}, &output); err != nil {
			t.Fatal(err)
		}
		archive, err := zip.NewReader(bytes.NewReader(output.Bytes()), int64(output.Len()))
		if err != nil {
			t.Fatal(err)
		}
		files := map[string]string{}
		for _, file := range archive.File {
			reader, err := file.Open()
			if err != nil {
				t.Fatal(err)
			}
			body, err := io.ReadAll(reader)
			reader.Close()
			if err != nil {
				t.Fatal(err)
			}
			files[file.Name] = string(body)
			for _, secret := range []string{"private-connection-token", "private-connection-content", "private-log-token", "private-conversation", "private-event-token", "conversation-other"} {
				if strings.Contains(string(body), secret) {
					t.Fatalf("archive leaked %s", secret)
				}
			}
			if selected == "" && strings.HasPrefix(file.Name, "events/") {
				t.Fatal("default archive contains conversation events")
			}
		}
		if files["versions.json"] == "" || files["engine.json"] == "" || files["logs/production/engine/recent.ndjson"] == "" || files["logs/production/engine/old.ndjson"] != "" {
			t.Fatalf("unexpected archive entries: %v", files)
		}
		if selected != "" && !strings.Contains(files["events/session-selected.jsonl"], "conversation-selected") {
			t.Fatal("explicit session events are missing")
		}
	}
}

func TestBundleRedactsEveryMCPEnvironmentValue(t *testing.T) {
	directory := t.TempDir()
	if err := os.WriteFile(filepath.Join(directory, "merakcode.json"), []byte(`{/* configuration */"mcpServers":{"docs":{"command":"node","env":{"PLAIN_NAME":"private-environment-value"}},},}`), 0600); err != nil {
		t.Fatal(err)
	}
	var output bytes.Buffer
	if err := (diagnose.Bundler{DataDir: directory}).Bundle(t.Context(), diagnose.Request{WithConfig: true}, &output); err != nil {
		t.Fatal(err)
	}
	archive, err := zip.NewReader(bytes.NewReader(output.Bytes()), int64(output.Len()))
	if err != nil {
		t.Fatal(err)
	}
	for _, file := range archive.File {
		reader, err := file.Open()
		if err != nil {
			t.Fatal(err)
		}
		body, err := io.ReadAll(reader)
		reader.Close()
		if err != nil {
			t.Fatal(err)
		}
		if strings.Contains(string(body), "private-environment-value") {
			t.Fatal("MCP environment value leaked")
		}
	}
}
