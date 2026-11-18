package worker_test

import (
	"bufio"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
)

func init() {
	for i, arg := range os.Args {
		if arg == "--merak-worker-fixture" && i+2 < len(os.Args) {
			if i+4 < len(os.Args) && os.Args[i+3] == "--initial-state" {
				body, err := os.ReadFile(os.Args[i+2])
				if err != nil || string(body) != os.Args[i+4] {
					os.Exit(25)
				}
				if os.Args[i+1] == "claude-code" {
					if os.Getenv("CLAUDE_CONFIG_DIR") != filepath.Dir(os.Args[i+2]) {
						os.Exit(28)
					}
					home, _ := os.UserHomeDir()
					if err := os.WriteFile(filepath.Join(home, ".claude.json"), []byte("forbidden"), 0600); !os.IsPermission(err) {
						os.Exit(29)
					}
				}
			}
			if i+4 < len(os.Args) && os.Args[i+3] == "--real-home" {
				home, err := os.UserHomeDir()
				if err != nil || home != os.Args[i+4] {
					os.Exit(24)
				}
			}
			if i+4 < len(os.Args) && os.Args[i+3] == "--denied-state" {
				if _, err := os.ReadFile(os.Args[i+4]); !os.IsPermission(err) {
					os.Exit(23)
				}
			}
			runSandboxWorkerFixture(os.Args[i+1], os.Args[i+2])
			os.Exit(0)
		}
	}
}

func runSandboxWorkerFixture(kind, path string) {
	if kind == "command" {
		if err := os.WriteFile(path, []byte("worker output"), 0600); err != nil {
			fmt.Fprintln(os.Stderr, err)
			os.Exit(1)
		}
		fmt.Print("finished")
		return
	}
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
				fmt.Fprintln(os.Stderr, err)
				os.Exit(1)
			}
			send(map[string]any{"type": "result", "subtype": "success", "result": "written"})
			return
		}
		if kind == "pi" {
			if err := os.WriteFile(path, []byte("worker output"), 0o600); err != nil {
				fmt.Fprintln(os.Stderr, err)
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
				fmt.Fprintln(os.Stderr, err)
				os.Exit(1)
			}
			reply(map[string]string{"stopReason": "end_turn"})
		case "turn/start":
			if err := os.WriteFile(path, []byte("worker output"), 0o600); err != nil {
				fmt.Fprintln(os.Stderr, err)
				os.Exit(1)
			}
			reply(map[string]any{"turn": map[string]string{"id": "fixture-turn", "status": "inProgress"}})
			send(map[string]any{"method": "turn/completed", "params": map[string]any{"threadId": "fixture-thread", "turn": map[string]string{"id": "fixture-turn", "status": "completed"}}})
		default:
			os.Exit(4)
		}
	}
}
