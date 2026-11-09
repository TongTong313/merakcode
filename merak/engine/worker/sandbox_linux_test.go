package worker_test

import (
	"bufio"
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/TongTong313/merakcode/merak/engine/event"
	"github.com/TongTong313/merakcode/merak/engine/profile"
	"github.com/TongTong313/merakcode/merak/engine/store/memory"
	"github.com/TongTong313/merakcode/merak/engine/task"
	"github.com/TongTong313/merakcode/merak/engine/worker"
	"github.com/TongTong313/merakcode/merak/engine/worker/acp"
	"github.com/TongTong313/merakcode/merak/engine/worker/claudecode"
	"github.com/TongTong313/merakcode/merak/engine/worker/codex"
	"github.com/TongTong313/merakcode/merak/engine/worker/opencode"
	"github.com/TongTong313/merakcode/merak/engine/worker/pi"
	"github.com/TongTong313/merakcode/merak/internal/platform/sandbox"
)

func TestSandboxExternalWorkerWrites(t *testing.T) {
	for _, kind := range []string{"codex", "pi", "acp", "opencode", "claude-code"} {
		t.Run(kind, func(t *testing.T) { checkExternalWorkerSandboxWrites(t, kind) })
	}
}

func checkExternalWorkerSandboxWrites(t *testing.T, kind string) {
	t.Helper()
	root := t.TempDir()
	workspace := filepath.Join(root, "workspace")
	if err := os.Mkdir(workspace, 0o700); err != nil {
		t.Fatal(err)
	}
	for _, test := range []struct {
		name, path string
		allowed    bool
	}{
		{"inside", filepath.Join(workspace, "output"), true},
		{"outside", filepath.Join(root, "output"), false},
	} {
		t.Run(test.name, func(t *testing.T) {
			ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
			defer cancel()
			bus := event.NewBus(memory.New(), time.Now, event.NewID)
			product := profile.Product{Binary: os.Args[0], Args: []string{"--merak-worker-fixture", kind, test.path}}
			var runner worker.Runner
			switch kind {
			case "codex":
				runner = &codex.Runner{Bus: bus, Sandbox: new(sandbox.Launcher), Product: product}
			case "pi":
				runner = &pi.Runner{Bus: bus, Sandbox: new(sandbox.Launcher), Product: product}
			case "acp":
				runner = &acp.Runner{Bus: bus, Sandbox: new(sandbox.Launcher), Product: product}
			case "opencode":
				runner = &opencode.Runner{Bus: bus, Sandbox: new(sandbox.Launcher), Product: product}
			case "claude-code":
				runner = &claudecode.Runner{Bus: bus, Sandbox: new(sandbox.Launcher), Product: product}
			default:
				t.Fatal("unknown product fixture")
			}
			run, err := runner.Start(ctx, worker.Assignment{Session: event.NewID(), Workdir: workspace, Claim: task.Claim{ID: event.NewID()}, SandboxProfile: sandbox.Profile{WriteAllow: []string{workspace}}})
			if err != nil {
				t.Fatal(err)
			}
			report, runErr := run.Wait(ctx)
			body, readErr := os.ReadFile(test.path)
			if test.allowed {
				if runErr != nil || report.Verdict != task.VerdictDone || readErr != nil || string(body) != "worker output" {
					t.Fatalf("allowed worker report=%+v error=%v file=%q error=%v", report, runErr, body, readErr)
				}
				return
			}
			if runErr == nil || report.Verdict != task.VerdictFailed || !os.IsNotExist(readErr) {
				t.Fatalf("outside worker report=%+v error=%v file error=%v", report, runErr, readErr)
			}
		})
	}
}

func init() {
	for i, arg := range os.Args {
		if arg == "--merak-worker-fixture" && i+2 < len(os.Args) {
			runSandboxWorkerFixture(os.Args[i+1], os.Args[i+2])
			os.Exit(0)
		}
	}
}

func runSandboxWorkerFixture(kind, path string) {
	if kind == "pi" && (os.Getenv("PI_SKIP_VERSION_CHECK") != "1" || os.Getenv("PI_TELEMETRY") != "0" || os.Getenv("PI_OFFLINE") != "1") {
		os.Exit(9)
	}
	if kind == "codex" {
		for _, setting := range []string{"analytics.enabled=false", "feedback.enabled=false", "check_for_update_on_startup=false", `otel.exporter="none"`, `otel.trace_exporter="none"`, `otel.metrics_exporter="none"`} {
			found := false
			for i, arg := range os.Args {
				if i > 0 && os.Args[i-1] == "-c" && arg == setting {
					found = true
				}
			}
			if !found {
				os.Exit(8)
			}
		}
	}
	if kind == "claude-code" && os.Getenv("CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC") != "1" {
		os.Exit(6)
	}
	if kind == "opencode" {
		for _, name := range []string{"OPENCODE_DISABLE_AUTOUPDATE", "OPENCODE_DISABLE_MODELS_FETCH", "OPENCODE_DISABLE_LSP_DOWNLOAD"} {
			if os.Getenv(name) != "1" {
				os.Exit(7)
			}
		}
		var config struct{ Permission string }
		if json.Unmarshal([]byte(os.Getenv("OPENCODE_CONFIG_CONTENT")), &config) != nil || config.Permission != "ask" {
			os.Exit(5)
		}
	}
	scan := bufio.NewScanner(os.Stdin)
	encoder := json.NewEncoder(os.Stdout)
	send := func(value any) {
		if encoder.Encode(value) != nil {
			os.Exit(2)
		}
	}
	for scan.Scan() {
		if kind == "claude-code" {
			var request struct {
				Type      string `json:"type"`
				RequestID string `json:"request_id"`
				Request   struct {
					Subtype string `json:"subtype"`
				} `json:"request"`
			}
			if err := json.Unmarshal(scan.Bytes(), &request); err != nil {
				os.Exit(10)
			}
			if request.Type == "control_request" && request.Request.Subtype == "initialize" {
				send(map[string]any{"type": "control_response", "response": map[string]any{"subtype": "success", "request_id": request.RequestID, "response": map[string]any{}}})
				continue
			}
			if request.Type != "user" {
				os.Exit(11)
			}
			if err := os.WriteFile(path, []byte("worker output"), 0o600); err != nil {
				os.Exit(1)
			}
			send(map[string]any{"type": "result", "subtype": "success", "result": "written"})
			return
		}
		if kind == "pi" {
			if err := os.WriteFile(path, []byte("worker output"), 0o600); err != nil {
				os.Exit(1)
			}
			send(map[string]any{"type": "agent_settled"})
			continue
		}
		var request struct {
			ID     json.RawMessage
			Method string
		}
		if err := json.Unmarshal(scan.Bytes(), &request); err != nil {
			os.Exit(3)
		}
		reply := func(value any) { send(map[string]any{"id": request.ID, "result": value}) }
		switch request.Method {
		case "initialize":
			if kind == "acp" || kind == "opencode" {
				reply(map[string]any{"protocolVersion": 1})
				continue
			}
			reply(map[string]any{"userAgent": "fixture"})
		case "initialized":
		case "thread/start":
			reply(map[string]any{"thread": map[string]string{"id": "fixture-thread"}})
		case "session/new":
			reply(map[string]string{"sessionId": "fixture-session"})
		case "session/prompt":
			if err := os.WriteFile(path, []byte("worker output"), 0o600); err != nil {
				os.Exit(1)
			}
			reply(map[string]string{"stopReason": "end_turn"})
		case "turn/start":
			if err := os.WriteFile(path, []byte("worker output"), 0o600); err != nil {
				os.Exit(1)
			}
			reply(map[string]any{"turn": map[string]string{"id": "fixture-turn", "status": "inProgress"}})
			send(map[string]any{"method": "turn/completed", "params": map[string]any{"threadId": "fixture-thread", "turn": map[string]string{"id": "fixture-turn", "status": "completed"}}})
		default:
			os.Exit(4)
		}
	}
}
