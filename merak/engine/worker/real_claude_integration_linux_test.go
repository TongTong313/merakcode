//go:build product_integration

package worker_test

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"syscall"
	"testing"
	"time"

	"github.com/TongTong313/merakcode/merak/engine/event"
	"github.com/TongTong313/merakcode/merak/engine/profile"
	"github.com/TongTong313/merakcode/merak/engine/store/memory"
	"github.com/TongTong313/merakcode/merak/engine/task"
	"github.com/TongTong313/merakcode/merak/engine/worker"
	"github.com/TongTong313/merakcode/merak/engine/worker/claudecode"
	"github.com/TongTong313/merakcode/merak/internal/platform/sandbox"
)

func init() {
	for i, arg := range os.Args {
		if arg != "--merak-real-claude-trace" || i+1 >= len(os.Args) {
			continue
		}
		args := append([]string{"/usr/bin/strace", "-f", "-e", "trace=file", "-o", os.Args[i+1], "/bin/claude"}, os.Args[1:i]...)
		args = append(args, os.Args[i+2:]...)
		if err := syscall.Exec(args[0], args, os.Environ()); err != nil {
			fmt.Fprintln(os.Stderr, err)
			os.Exit(127)
		}
	}
}

func TestRealClaudeFirstStartupKeepsUserHomeReadOnly(t *testing.T) {
	if out, err := exec.CommandContext(t.Context(), "/bin/claude", "--version").CombinedOutput(); err != nil {
		t.Fatalf("Claude executable: %v %s", err, out)
	} else {
		t.Log(strings.TrimSpace(string(out)))
	}
	if out, err := exec.CommandContext(t.Context(), "/usr/bin/strace", "--version").CombinedOutput(); err != nil {
		t.Fatalf("trace executable: %v %s", err, out)
	}
	home, workspace := t.TempDir(), t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("CLAUDE_CONFIG_DIR", "")
	configDirectory := filepath.Join(home, ".claude")
	if err := os.Mkdir(configDirectory, 0700); err != nil {
		t.Fatal(err)
	}
	legacy := filepath.Join(home, ".claude.json")
	if err := os.WriteFile(legacy, []byte(`{"fixture":"original configuration"}`), 0600); err != nil {
		t.Fatal(err)
	}
	credentials := filepath.Join(configDirectory, ".credentials.json")
	if err := os.WriteFile(credentials, []byte(`{"claudeAiOauth":{"accessToken":"fixture-oauth","refreshToken":"fixture-refresh","expiresAt":4102444800000,"scopes":["user:inference"],"subscriptionType":"pro"}}`), 0600); err != nil {
		t.Fatal(err)
	}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.HasSuffix(r.URL.Path, "count_tokens") {
			_ = json.NewEncoder(w).Encode(map[string]int{"input_tokens": 1})
			return
		}
		var request struct{ Stream bool }
		_ = json.NewDecoder(r.Body).Decode(&request)
		answer := `{"verdict":"done","summary":"real Claude startup completed"}`
		message := map[string]any{"id": "msg_fixture", "type": "message", "role": "assistant", "model": "claude-sonnet-4-6", "content": []map[string]string{{"type": "text", "text": answer}}, "stop_reason": "end_turn", "stop_sequence": nil, "usage": map[string]int{"input_tokens": 1, "output_tokens": 20}}
		if !request.Stream {
			_ = json.NewEncoder(w).Encode(message)
			return
		}
		w.Header().Set("Content-Type", "text/event-stream")
		send := func(name string, body any) {
			raw, _ := json.Marshal(body)
			_, _ = fmt.Fprintf(w, "event: %s\ndata: %s\n\n", name, raw)
		}
		message["content"] = []any{}
		message["stop_reason"] = nil
		send("message_start", map[string]any{"type": "message_start", "message": message})
		send("content_block_start", map[string]any{"type": "content_block_start", "index": 0, "content_block": map[string]string{"type": "text", "text": ""}})
		send("content_block_delta", map[string]any{"type": "content_block_delta", "index": 0, "delta": map[string]string{"type": "text_delta", "text": answer}})
		send("content_block_stop", map[string]any{"type": "content_block_stop", "index": 0})
		send("message_delta", map[string]any{"type": "message_delta", "delta": map[string]any{"stop_reason": "end_turn", "stop_sequence": nil}, "usage": map[string]int{"output_tokens": 20}})
		send("message_stop", map[string]string{"type": "message_stop"})
	}))
	defer server.Close()
	trace := filepath.Join(workspace, "startup.trace")
	product := profile.Product{Binary: os.Args[0], Args: []string{"--merak-real-claude-trace", trace}, Env: map[string]string{"ANTHROPIC_BASE_URL": server.URL, "ANTHROPIC_API_KEY": "fixture-key", "DISABLE_AUTOUPDATER": "1", "USE_BUILTIN_RIPGREP": "0"}}
	p := sandbox.Profile{WriteAllow: []string{workspace}, Network: sandbox.Network{Mode: "allowlist", LocalPorts: []int{server.Listener.Addr().(*net.TCPAddr).Port}}}
	for name := range product.Env {
		p.EnvAllow = append(p.EnvAllow, name)
	}
	launcher := new(sandbox.Launcher)
	defer launcher.Close()
	runner := &claudecode.Runner{Bus: event.NewBus(memory.New(), time.Now, event.NewID), Sandbox: launcher, Product: product}
	ctx, cancel := context.WithTimeout(t.Context(), 90*time.Second)
	defer cancel()
	run, err := runner.Start(ctx, worker.Assignment{Session: event.NewID(), Workdir: workspace, Packet: "Return the requested JSON result.", SandboxProfile: p})
	if err != nil {
		t.Fatal(err)
	}
	report, runErr := run.Wait(ctx)
	file, err := os.Open(trace)
	if err != nil {
		t.Fatalf("trace unavailable: %v; member error=%v", err, runErr)
	}
	defer file.Close()
	scan := bufio.NewScanner(file)
	pending := map[string]string{}
	var locked, temporary, readCredentials bool
	for scan.Scan() {
		line := scan.Text()
		fields := strings.Fields(line)
		if len(fields) < 2 {
			continue
		}
		pid := fields[0]
		if strings.Contains(line, "<unfinished ...>") {
			pending[pid] = strings.TrimSuffix(line, "<unfinished ...>")
			continue
		}
		if before, ok := pending[pid]; ok && strings.Contains(line, " resumed>") {
			line = before + strings.SplitN(line, " resumed>", 2)[1]
			delete(pending, pid)
		}
		succeeded := strings.Contains(line, " = ") && !strings.Contains(line, " = -1 ")
		if succeeded && strings.Contains(line, `"`+configDirectory+`/.claude.json.lock"`) && strings.Contains(line, "mkdir(") {
			locked = true
		}
		if succeeded && strings.Contains(line, `"`+configDirectory+`/.claude.json.tmp.`) && strings.Contains(line, "O_EXCL") {
			temporary = true
		}
		if succeeded && strings.Contains(line, `"`+credentials+`"`) && strings.Contains(line, "O_RDONLY") {
			readCredentials = true
		}
		if !strings.Contains(line, home) || !(strings.Contains(line, "O_WRONLY") || strings.Contains(line, "O_RDWR") || strings.Contains(line, "rename") || strings.Contains(line, "unlink") || strings.Contains(line, "mkdir")) {
			continue
		}
		t.Log(line)
		if strings.Contains(line, "EACCES") || strings.Contains(line, "EPERM") {
			t.Errorf("Claude attempted an unprepared home write: %s", line)
		}
	}
	if err := scan.Err(); err != nil {
		t.Fatal(err)
	}
	if !locked || !temporary || !readCredentials {
		t.Errorf("Claude state paths: directory=%s lock=%t temporary=%t credentials=%s read=%t", configDirectory, locked, temporary, credentials, readCredentials)
	}
	if original, err := os.ReadFile(legacy); err != nil || string(original) != `{"fixture":"original configuration"}` {
		t.Errorf("legacy configuration changed: path=%s error=%v", legacy, err)
	}
	if runErr != nil || report.Verdict != task.VerdictDone {
		t.Fatalf("real Claude startup: report=%+v error=%v", report, runErr)
	}
}
