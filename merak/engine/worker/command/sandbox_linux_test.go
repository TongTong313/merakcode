package command_test

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/TongTong313/merakcode/merak/engine/event"
	"github.com/TongTong313/merakcode/merak/engine/profile"
	"github.com/TongTong313/merakcode/merak/engine/store/memory"
	"github.com/TongTong313/merakcode/merak/engine/task"
	"github.com/TongTong313/merakcode/merak/engine/worker"
	"github.com/TongTong313/merakcode/merak/engine/worker/command"
	"github.com/TongTong313/merakcode/merak/internal/platform/sandbox"
)

func TestCommandSandboxConfinesWorkerWrites(t *testing.T) {
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
			runner := &command.Runner{
				Bus:     event.NewBus(memory.New(), time.Now, event.NewID),
				Sandbox: new(sandbox.Launcher),
				Product: profile.Product{Binary: os.Args[0], Args: []string{"-test.run=^TestCommandSandboxChild$", "--", test.path}},
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

func TestCommandSandboxChild(t *testing.T) {
	for i, argument := range os.Args {
		if argument != "--" || i+1 >= len(os.Args) {
			continue
		}
		if err := os.WriteFile(os.Args[i+1], []byte("worker output"), 0o600); err != nil {
			os.Exit(1)
		}
		fmt.Print("written")
		os.Exit(0)
	}
}
