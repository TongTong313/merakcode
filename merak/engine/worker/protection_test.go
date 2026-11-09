package worker_test

import (
	"context"
	"os"
	"path/filepath"
	"runtime"
	"strings"
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

func TestExternalWorkersRestoreProtectionBeforeCompleting(t *testing.T) {
	for _, kind := range []string{"codex", "pi", "acp", "opencode", "claude-code"} {
		t.Run(kind, func(t *testing.T) {
			home := t.TempDir()
			t.Setenv("HOME", home)
			t.Setenv("USERPROFILE", home)
			t.Setenv("CLAUDE_CONFIG_DIR", "")
			workspace, err := filepath.EvalSymlinks(t.TempDir())
			if err != nil {
				t.Fatal(err)
			}
			path := filepath.Join(workspace, "merakcode.json")
			if err := os.WriteFile(path, []byte("original"), 0600); err != nil {
				t.Fatal(err)
			}
			launcher := &sandbox.Launcher{Unavailable: func(context.Context, sandbox.Status) error { return nil }}
			t.Cleanup(func() {
				if err := launcher.Close(); err != nil {
					t.Error(err)
				}
			})
			bus := event.NewBus(memory.New(), time.Now, event.NewID)
			product := profile.Product{Binary: os.Args[0], Args: []string{"--merak-worker-fixture", kind, path}}
			var runner worker.Runner
			switch kind {
			case "codex":
				runner = &codex.Runner{Bus: bus, Sandbox: launcher, Product: product}
			case "pi":
				runner = &pi.Runner{Bus: bus, Sandbox: launcher, Product: product}
			case "acp":
				runner = &acp.Runner{Bus: bus, Sandbox: launcher, Product: product}
			case "opencode":
				runner = &opencode.Runner{Bus: bus, Sandbox: launcher, Product: product}
			case "claude-code":
				runner = &claudecode.Runner{Bus: bus, Sandbox: launcher, Product: product}
			}
			ctx, cancel := context.WithTimeout(t.Context(), 15*time.Second)
			defer cancel()
			run, err := runner.Start(ctx, worker.Assignment{Session: event.NewID(), Workdir: workspace, Claim: task.Claim{ID: event.NewID()},
				SandboxProfile: sandbox.Profile{WriteAllow: []string{workspace}, Protect: []string{path}, EnvAllow: []string{"SystemRoot"}},
			})
			if err != nil {
				t.Fatal(err)
			}
			report, runErr := run.Wait(ctx)
			body, err := os.ReadFile(path)
			if err != nil || string(body) != "original" {
				t.Fatalf("protected file = %q, %v", body, err)
			}
			code := "MRK-5007"
			if runtime.GOOS == "darwin" {
				code = "MRK-5009"
			}
			if runErr == nil || !strings.Contains(runErr.Error(), code) || report.Verdict != task.VerdictFailed {
				t.Fatalf("report=%+v error=%v", report, runErr)
			}
		})
	}
}
