package cli

import (
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/TongTong313/merakcode/merak"
)

func TestDebugChatAsksBeforeRunningCommands(t *testing.T) {
	for _, answer := range []string{"y\n", "n\n"} {
		t.Run(strings.TrimSpace(answer), func(t *testing.T) {
			dir := t.TempDir()
			t.Setenv("MERAKCODE_HOME", dir)
			t.Setenv("MERAKCODE_LANG", "en")
			path := filepath.Join(dir, "command.txt")
			command := "printf approved > '" + strings.ReplaceAll(filepath.ToSlash(path), "'", "'\\''") + "'"
			script, err := json.Marshal([]any{
				map[string]any{"calls": []any{map[string]any{"id": "bash-1", "name": "bash", "input": map[string]string{"command": command}}}},
				map[string]string{"text": "Finished."},
			})
			if err != nil {
				t.Fatal(err)
			}
			scriptPath := filepath.Join(dir, "command.json")
			if err := os.WriteFile(scriptPath, script, 0o600); err != nil {
				t.Fatal(err)
			}
			var output bytes.Buffer
			code := Run([]string{"debug", "chat", "--script", scriptPath, "Run the command"}, strings.NewReader(answer), &output)
			if code != 0 || !strings.Contains(output.String(), command) || !strings.Contains(output.String(), "[y/n]") {
				t.Fatalf("command approval = (%d, %q)", code, output.String())
			}
			data, err := os.ReadFile(path)
			if answer == "y\n" && (err != nil || string(data) != "approved") {
				t.Fatalf("approved command did not run: %q %v", data, err)
			}
			if answer == "n\n" && !os.IsNotExist(err) {
				t.Fatal("denied command ran")
			}
		})
	}
}

func TestRunPrintsModelTextBeforeTheStreamFinishes(t *testing.T) {
	home := t.TempDir()
	t.Setenv("MERAKCODE_HOME", home)
	cleanupEngine(t, home)
	t.Setenv("OPENAI_API_KEY", "test-key")
	t.Setenv("OPENAI_MODEL", "fixture-model")
	release := make(chan struct{})
	started := make(chan struct{})
	var once sync.Once
	unblock := func() { once.Do(func() { close(release) }) }
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var req struct {
			Model string `json:"model"`
		}
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			t.Error(err)
		}
		if req.Model != "fixture-model" || r.Header.Get("Authorization") != "Bearer test-key" {
			t.Error("missing environment configuration")
		}
		w.Header().Set("Content-Type", "text/event-stream")
		_, _ = io.WriteString(w, "data: {\"choices\":[{\"index\":0,\"delta\":{\"content\":\"Hello\"}}]}\n\n")
		w.(http.Flusher).Flush()
		close(started)
		select {
		case <-release:
		case <-r.Context().Done():
			return
		}
		_, _ = io.WriteString(w, "data: {\"choices\":[{\"index\":0,\"delta\":{\"content\":\" world\"},\"finish_reason\":\"stop\"}]}\n\ndata: [DONE]\n\n")
	}))
	defer server.Close()
	defer unblock()
	t.Setenv("OPENAI_BASE_URL", server.URL)
	reader, writer := io.Pipe()
	defer reader.Close()
	done := make(chan int, 1)
	go func() { done <- Run([]string{"run", "Say hello"}, strings.NewReader(""), writer); writer.Close() }()
	first := make(chan string, 1)
	go func() { data := make([]byte, 5); _, _ = io.ReadFull(reader, data); first <- string(data) }()
	select {
	case <-started:
	case <-time.After(15 * time.Second):
		t.Fatal("engine did not start a model request")
	}
	select {
	case text := <-first:
		if text != "Hello" {
			t.Fatalf("first output = %q", text)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("text was buffered until the stream finished")
	}
	unblock()
	rest, err := io.ReadAll(reader)
	if err != nil || string(rest) != " world\n" {
		t.Fatalf("remaining output = %q, error=%v", rest, err)
	}
	if code := <-done; code != 0 {
		t.Fatalf("exit code = %d", code)
	}
}

func TestDebugChatRequiresStdinApprovalForWrites(t *testing.T) {
	for _, test := range []struct {
		name    string
		answer  string
		allowed bool
	}{
		{"allows an approved write", "y\n", true},
		{"rejects a denied write", "n\n", false},
		{"rejects unanswered approval", "", false},
	} {
		t.Run(test.name, func(t *testing.T) {
			dir := t.TempDir()
			t.Setenv("MERAKCODE_HOME", dir)
			t.Setenv("MERAKCODE_LANG", "zh")
			path := filepath.Join(dir, "result.txt")
			script, err := json.Marshal([]any{
				map[string]any{"calls": []any{map[string]any{"id": "write-1", "name": "write_file", "input": map[string]string{"path": path, "content": "Approved content"}}}},
				map[string]string{"text": "Finished."},
			})
			if err != nil {
				t.Fatal(err)
			}
			scriptPath := filepath.Join(dir, "write.json")
			if err := os.WriteFile(scriptPath, script, 0o600); err != nil {
				t.Fatal(err)
			}
			var output bytes.Buffer
			code := Run([]string{"debug", "chat", "--script", scriptPath, "Write the file"}, strings.NewReader(test.answer), &output)
			if code != 0 || !strings.Contains(output.String(), "[y/n]") || !strings.HasSuffix(output.String(), "Finished.\n") {
				t.Fatalf("Run = (%d, %q)", code, output.String())
			}
			data, err := os.ReadFile(path)
			if test.allowed && (err != nil || string(data) != "Approved content") {
				t.Fatalf("approved write failed: %q, %v", data, err)
			}
			if !test.allowed && !os.IsNotExist(err) {
				t.Fatalf("unapproved file exists: %v", err)
			}
		})
	}
}

func TestDebugChatRunsAScript(t *testing.T) {
	t.Setenv("MERAKCODE_HOME", t.TempDir())
	t.Setenv("MERAKCODE_LANG", "en")
	for _, test := range []struct {
		name   string
		args   []string
		code   int
		output string
	}{
		{
			name: "prints the scripted answer",
			args: []string{"debug", "chat", "--script", filepath.Join("..", "..", "testdata", "hello.json"), "Hello"},
			code: 0, output: "Hello from the scripted model.\n",
		},
		{name: "requires a script", args: []string{"debug", "chat", "Hello"}, code: 2, output: "[MRK-3001] Invalid command arguments\nCheck the command, model name and argument values.\n"},
	} {
		t.Run(test.name, func(t *testing.T) {
			var output bytes.Buffer
			code := Run(test.args, strings.NewReader(""), &output)
			if code != test.code || output.String() != test.output {
				t.Fatalf("Run = (%d, %q), want (%d, %q)", code, output.String(), test.code, test.output)
			}
		})
	}
}

func TestDebugChatPrintsSafeCredentialPrefixAtCompletion(t *testing.T) {
	t.Setenv("MERAKCODE_HOME", t.TempDir())
	script := filepath.Join(t.TempDir(), "reply.json")
	if err := os.WriteFile(script, []byte(`[{"text":"Yes sk"}]`), 0600); err != nil {
		t.Fatal(err)
	}
	var output bytes.Buffer
	if code := Run([]string{"debug", "chat", "--script", script, "Hello"}, strings.NewReader(""), &output); code != 0 || output.String() != "Yes sk\n" {
		t.Fatalf("code=%d output=%q", code, output.String())
	}
}

func TestRun(t *testing.T) {
	t.Setenv("MERAKCODE_LANG", "en")
	tests := []struct {
		name   string
		args   []string
		code   int
		output string
	}{
		{name: "prints the version", args: []string{"--version"}, code: 0, output: merak.Version() + "\n"},
		{name: "rejects other arguments", args: []string{"unsupported"}, code: 2, output: "[MRK-3001] Invalid command arguments\nCheck the command, model name and argument values.\n"},
		{name: "rejects no arguments", args: nil, code: 2, output: "[MRK-3001] Invalid command arguments\nCheck the command, model name and argument values.\n"},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			var output bytes.Buffer
			if code := Run(test.args, strings.NewReader(""), &output); code != test.code {
				t.Errorf("Run(%q) = %d, want %d", test.args, code, test.code)
			}
			if output.String() != test.output {
				t.Errorf("Run(%q) printed %q, want %q", test.args, output.String(), test.output)
			}
		})
	}
}
