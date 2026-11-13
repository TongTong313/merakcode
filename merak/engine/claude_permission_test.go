package engine_test

import (
	"context"
	"os"
	"path/filepath"
	"sync/atomic"
	"testing"
	"time"

	"github.com/TongTong313/merakcode/merak/engine"
	"github.com/TongTong313/merakcode/merak/engine/agent"
	"github.com/TongTong313/merakcode/merak/engine/permission"
	"github.com/TongTong313/merakcode/merak/engine/task"
	"github.com/TongTong313/merakcode/merak/engine/worker"
	"github.com/TongTong313/merakcode/merak/internal/platform/process"
)

func TestClaudeCodeForwardsToolApprovalsToTheEngine(t *testing.T) {
	binary := filepath.Join(t.TempDir(), "claude-fixture.exe")
	build := process.Command(t.Context(), "", "go", "build", "-o", binary, "./worker/claudecode/testdata/fakeclaude")
	if output, err := build.CombinedOutput(); err != nil {
		t.Fatalf("build: %v %s", err, output)
	}
	for _, test := range []struct {
		name      string
		mode      permission.Mode
		decision  permission.Decision
		allowed   bool
		approvals int32
	}{
		{"allow", permission.ModeAsk, permission.Allow, true, 1},
		{"deny", permission.ModeAsk, permission.Deny, false, 1},
		{"takeover", permission.ModeTakeover, permission.Deny, true, 0},
	} {
		t.Run(test.name, func(t *testing.T) {
			workspace := t.TempDir()
			var asked atomic.Int32
			e, err := engine.New(engine.Deps{Ask: func(_ context.Context, request permission.Request) (permission.Reply, error) {
				if request.Kind == "launch" {
					t.Error("Claude Code requested unrestricted startup instead of forwarding tool approval")
					return permission.Reply{Decision: permission.Deny}, nil
				}
				if request.Call.Name != "Write" {
					t.Errorf("unexpected tool approval: %s", request.Call.Name)
				}
				asked.Add(1)
				return permission.Reply{Decision: test.decision}, nil
			}})
			if err != nil {
				t.Fatal(err)
			}
			defer e.Close()
			p := agent.DefaultMerakCode()
			p.Mode = test.mode
			p.Product = &agent.Product{Kind: worker.KindClaudeCode, Binary: binary, Args: []string{"--request-permission"}}
			ctx, cancel := context.WithTimeout(t.Context(), 5*time.Second)
			defer cancel()
			run, err := e.StartWorker(ctx, p, worker.Assignment{Session: "claude-approval", Workdir: workspace, Packet: "Write a file", Claim: task.Claim{Member: "claude-member"}})
			if err != nil {
				t.Fatal(err)
			}
			report, err := run.Wait(ctx)
			if err != nil {
				t.Fatal(err)
			}
			want := "Denied"
			if test.allowed {
				want = "Allowed"
			}
			if asked.Load() != test.approvals || report.Summary != want {
				t.Fatalf("approvals=%d report=%+v", asked.Load(), report)
			}
			state, err := e.SessionSnapshot(ctx, "claude-approval")
			if err != nil || state.Config.Mode != test.mode || state.Config.Member != "claude-member" {
				t.Fatalf("session config=%+v error=%v", state.Config, err)
			}
			body, readErr := os.ReadFile(filepath.Join(workspace, "approved.txt"))
			if test.allowed && (readErr != nil || string(body) != "approved") || !test.allowed && !os.IsNotExist(readErr) {
				t.Fatalf("file=%q error=%v", body, readErr)
			}
		})
	}
}
