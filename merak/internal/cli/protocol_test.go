package cli

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync/atomic"
	"testing"

	"github.com/TongTong313/merakcode/merak/engine"
	"github.com/TongTong313/merakcode/merak/engine/event"
	"github.com/TongTong313/merakcode/merak/engine/loop"
	"github.com/TongTong313/merakcode/merak/engine/model"
	"github.com/TongTong313/merakcode/merak/engine/model/catalog"
	"github.com/TongTong313/merakcode/merak/engine/model/fake"
	"github.com/TongTong313/merakcode/merak/engine/question"
	"github.com/TongTong313/merakcode/merak/internal/server"
)

func TestModelsReadsTheRunningEnginesConfiguration(t *testing.T) {
	home := t.TempDir()
	t.Setenv("MERAKCODE_HOME", home)
	e, err := engine.New(engine.Deps{Workdir: home})
	if err != nil {
		t.Fatal(err)
	}
	e.ConfigureModels([]catalog.Override{{Provider: "company", ID: "configured", Window: new(7777)}})
	instance, err := startAt(e, home)
	if err != nil {
		t.Fatal(err)
	}
	defer instance.Close()
	// Server configuration is applied at startup, then live changes must be visible.
	e.ConfigureModels([]catalog.Override{{Provider: "company", ID: "configured", Window: new(7777)}})
	var out bytes.Buffer
	if code := Run([]string{"models"}, strings.NewReader(""), &out); code != 0 || !strings.Contains(out.String(), "configured") {
		t.Fatalf("code=%d output=%s", code, &out)
	}
}

func TestRunJSONUsesConfiguredProviderAndAnswersQuestions(t *testing.T) {
	home := t.TempDir()
	t.Setenv("MERAKCODE_HOME", home)
	var instance *server.Instance
	provider := fake.New(t, fake.Reply{Calls: []model.ToolCall{{ID: "question", Name: "ask_user", Input: json.RawMessage(`{"text":"Which target?","options":["main","next"]}`)}}}, fake.Reply{Text: "Used main", Expect: func(req model.Request) error {
		body, _ := json.Marshal(req.Messages)
		if !strings.Contains(string(body), "main") {
			return fmt.Errorf("answer missing")
		}
		return nil
	}})
	e, err := engine.New(engine.Deps{Workdir: home, Providers: map[string]model.Provider{"company-relay": provider}, AskQuestion: func(ctx context.Context, req question.Request) (question.Answer, error) {
		return instance.AskQuestion(ctx, req)
	}})
	if err != nil {
		t.Fatal(err)
	}
	instance, err = startAt(e, home)
	if err != nil {
		t.Fatal(err)
	}
	defer instance.Close()
	var out bytes.Buffer
	if code := Run([]string{"run", "--json", "--provider", "company-relay", "--model", "fixture", "Begin"}, strings.NewReader("{\"text\":\"main\"}\n"), &out); code != 0 {
		t.Fatalf("code=%d output=%s", code, &out)
	}
	decoder := json.NewDecoder(&out)
	asked, finished := false, false
	for decoder.More() {
		var fact event.Event
		if err := decoder.Decode(&fact); err != nil {
			t.Fatal(err)
		}
		asked = asked || fact.Type == question.Asked
		finished = finished || fact.Type == loop.TurnFinished
	}
	if !asked || !finished {
		t.Fatalf("asked=%v finished=%v", asked, finished)
	}
}

func TestRunUsesTheDataFolderUnderTheMerakcodeRoot(t *testing.T) {
	root := t.TempDir()
	t.Setenv("MERAKCODE_HOME", "")
	for _, key := range []string{"HOME", "USERPROFILE", "APPDATA", "XDG_DATA_HOME"} {
		t.Setenv(key, root)
	}
	home := filepath.Join(root, "merakcode")
	if runtime.GOOS == "windows" {
		home = filepath.Join(root, "MerakCode")
	}
	if runtime.GOOS == "darwin" {
		home = filepath.Join(root, "Library", "Application Support", "MerakCode")
	}
	for _, entry := range []struct{ path, text string }{{home, "Platform directory"}, {filepath.Join(root, ".merakcode", "data"), "Merakcode directory"}} {
		e, err := engine.New(engine.Deps{Workdir: root, Providers: map[string]model.Provider{"openai": fake.New(t, fake.Reply{Text: entry.text})}})
		if err != nil {
			t.Fatal(err)
		}
		instance, err := server.Start(e, entry.path)
		if err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() { instance.Close() })
	}
	var output bytes.Buffer
	if code := Run([]string{"run", "--model", "fixture", "Hello"}, strings.NewReader(""), &output); code != 0 || output.String() != "Merakcode directory\n" {
		t.Fatalf("code=%d output=%q", code, output.String())
	}
}

func TestServeWritesScopedEngineLogsWithoutConversationText(t *testing.T) {
	home := t.TempDir()
	t.Setenv("MERAKCODE_HOME", home)
	cleanupEngine(t, home)
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		fmt.Fprint(w, "data: {\"choices\":[{\"index\":0,\"delta\":{\"content\":\"private-answer\"},\"finish_reason\":\"stop\"}]}\n\ndata: [DONE]\n\n")
	}))
	defer upstream.Close()
	t.Setenv("OPENAI_BASE_URL", upstream.URL)
	var output bytes.Buffer
	if code := Run([]string{"run", "--model", "fixture", "private-question"}, strings.NewReader(""), &output); code != 0 {
		t.Fatalf("code=%d output=%s", code, output.String())
	}
	if code := Run([]string{"stop"}, strings.NewReader(""), &output); code != 0 {
		t.Fatalf("stop=%d", code)
	}
	files, err := filepath.Glob(filepath.Join(home, "logs", "production", "engine", "*.ndjson"))
	if err != nil || len(files) == 0 {
		t.Fatalf("files=%v error=%v", files, err)
	}
	scoped := false
	for _, file := range files {
		body, err := os.ReadFile(file)
		if err != nil {
			t.Fatal(err)
		}
		if strings.Contains(string(body), "private-question") || strings.Contains(string(body), "private-answer") {
			t.Fatal("engine logged conversation text")
		}
		for _, line := range strings.Split(strings.TrimSpace(string(body)), "\n") {
			var row map[string]any
			if err := json.Unmarshal([]byte(line), &row); err != nil {
				t.Fatal(err)
			}
			if row["session"] != "" && row["event"] != "" {
				scoped = true
			}
		}
	}
	if !scoped {
		t.Fatal("engine log lacks event correlation")
	}
}

func TestRunUsesTheExistingEngineThroughTheProtocol(t *testing.T) {
	home := t.TempDir()
	t.Setenv("MERAKCODE_HOME", home)
	var direct atomic.Int32
	trap := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { direct.Add(1); w.WriteHeader(400) }))
	defer trap.Close()
	t.Setenv("OPENAI_BASE_URL", trap.URL)
	e, err := engine.New(engine.Deps{Workdir: home, Providers: map[string]model.Provider{"openai": fake.New(t, fake.Reply{Text: "From the running engine."})}})
	if err != nil {
		t.Fatal(err)
	}
	instance, err := startAt(e, home)
	if err != nil {
		t.Fatal(err)
	}
	defer instance.Close()
	var output bytes.Buffer
	code := Run([]string{"run", "--model", "fixture", "Hello"}, strings.NewReader(""), &output)
	if code != 0 || output.String() != "From the running engine.\n" || direct.Load() != 0 {
		t.Fatalf("code=%d output=%q direct=%d", code, output.String(), direct.Load())
	}
	logs, err := filepath.Glob(filepath.Join(home, "logs", "production", "cli", "*.ndjson"))
	if err != nil || len(logs) != 1 {
		t.Fatalf("logs=%v err=%v", logs, err)
	}
	log, err := os.ReadFile(logs[0])
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Contains(log, []byte(`"msg":"chat finished"`)) || bytes.Contains(log, []byte("From the running engine.")) {
		t.Fatalf("invalid command diagnostics: %s", log)
	}
}

func TestProtocolRunRequiresTerminalApprovalBeforeWriting(t *testing.T) {
	for _, answer := range []string{"y\n", "n\n"} {
		t.Run(strings.TrimSpace(answer), func(t *testing.T) {
			home := t.TempDir()
			t.Setenv("MERAKCODE_HOME", home)
			cleanupEngine(t, home)
			t.Setenv("MERAKCODE_LANG", "en")
			path := filepath.Join(home, "result.txt")
			input, _ := json.Marshal(map[string]string{"path": path, "content": "Approved"})
			var attempt atomic.Int32
			upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if attempt.Add(1) == 1 {
					chunk, _ := json.Marshal(map[string]any{"choices": []any{map[string]any{"index": 0, "delta": map[string]any{"tool_calls": []any{map[string]any{"index": 0, "id": "write-one", "type": "function", "function": map[string]string{"name": "write_file", "arguments": string(input)}}}}, "finish_reason": "tool_calls"}}})
					fmt.Fprintf(w, "data: %s\n\ndata: [DONE]\n\n", chunk)
					return
				}
				fmt.Fprint(w, "data: {\"choices\":[{\"index\":0,\"delta\":{\"content\":\"Finished.\"},\"finish_reason\":\"stop\"}]}\n\ndata: [DONE]\n\n")
			}))
			defer upstream.Close()
			t.Setenv("OPENAI_BASE_URL", upstream.URL)
			var output bytes.Buffer
			code := Run([]string{"run", "--model", "fixture", "Write"}, strings.NewReader(answer), &output)
			if code != 0 || !strings.Contains(output.String(), "Allow writing") {
				t.Fatalf("code=%d output=%q", code, output.String())
			}
			body, err := os.ReadFile(path)
			if answer == "y\n" && (err != nil || string(body) != "Approved") {
				t.Fatalf("write=%q err=%v", body, err)
			}
			if answer == "n\n" && !os.IsNotExist(err) {
				t.Fatal("unapproved write ran")
			}
		})
	}
}
