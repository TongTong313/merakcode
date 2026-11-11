//go:build linux || darwin

package worker_test

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/TongTong313/merakcode/merak/engine/agent"
	"github.com/TongTong313/merakcode/merak/engine/event"
	"github.com/TongTong313/merakcode/merak/engine/model"
	"github.com/TongTong313/merakcode/merak/engine/session"
	"github.com/TongTong313/merakcode/merak/engine/store/memory"
	"github.com/TongTong313/merakcode/merak/engine/worker"
	"github.com/TongTong313/merakcode/merak/engine/worker/command"
	"github.com/TongTong313/merakcode/merak/internal/platform/sandbox"
)

func TestWorkerCannotReadProductStateCreatedAfterLaunch(t *testing.T) {
	home, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	workspace, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	t.Setenv("HOME", home)
	path := filepath.Join(home, ".codex", "fixture")
	release := filepath.Join(workspace, "continue")
	ctx, cancel := context.WithTimeout(t.Context(), 10*time.Second)
	defer cancel()
	launcher := new(sandbox.Launcher)
	defer launcher.Close()
	runner := &command.Runner{Bus: event.NewBus(memory.New(), time.Now, event.NewID), Sandbox: launcher,
		Product: agent.Product{Binary: os.Args[0], Args: []string{"--merak-late-state-fixture", path, release}}}
	run, err := runner.Start(ctx, worker.Assignment{Session: event.NewID(), Workdir: workspace, SandboxProfile: sandbox.Profile{WriteAllow: []string{workspace}}})
	if err != nil {
		t.Fatal(err)
	}
	for {
		select {
		case fact, open := <-run.Events():
			if !open {
				_, err := run.Wait(ctx)
				t.Fatalf("worker exited before readiness: %v", err)
			}
			if fact.Type != session.MessageDelta {
				continue
			}
			chunk, err := event.Decode[model.Chunk](fact)
			if err != nil || !strings.Contains(chunk.Text, "ready") {
				continue
			}
			if err := sandbox.PrepareStateDirectory(filepath.Dir(path)); err != nil {
				t.Fatal(err)
			}
			if err := os.WriteFile(path, []byte("other product fixture"), 0600); err != nil {
				t.Fatal(err)
			}
			if err := os.WriteFile(release, nil, 0600); err != nil {
				t.Fatal(err)
			}
			if report, err := run.Wait(ctx); err != nil || !strings.Contains(report.Summary, "denied") {
				t.Fatalf("late product read was not denied: report=%+v error=%v", report, err)
			}
			return
		case <-ctx.Done():
			t.Fatal(ctx.Err())
		}
	}
}

func init() {
	if len(os.Args) != 4 || os.Args[1] != "--merak-late-state-fixture" {
		return
	}
	fmt.Println("ready")
	for {
		if _, err := os.Stat(os.Args[3]); err == nil {
			break
		}
		time.Sleep(10 * time.Millisecond)
	}
	if _, err := os.ReadFile(os.Args[2]); !os.IsPermission(err) {
		os.Exit(31)
	}
	fmt.Println("denied")
	os.Exit(0)
}
