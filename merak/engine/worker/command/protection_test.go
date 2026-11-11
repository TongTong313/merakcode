package command_test

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"

	"github.com/TongTong313/merakcode/merak/engine/agent"
	"github.com/TongTong313/merakcode/merak/engine/event"
	"github.com/TongTong313/merakcode/merak/engine/store/memory"
	"github.com/TongTong313/merakcode/merak/engine/task"
	"github.com/TongTong313/merakcode/merak/engine/worker"
	"github.com/TongTong313/merakcode/merak/engine/worker/command"
	"github.com/TongTong313/merakcode/merak/internal/platform/sandbox"
)

func TestCommandRestoresProtectionBeforeCompletingItsReport(t *testing.T) {
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
	runner := &command.Runner{
		Bus: event.NewBus(memory.New(), time.Now, event.NewID), Sandbox: launcher,
		Product: agent.Product{Binary: os.Args[0], Args: []string{"-test.run=^TestProtectionChild$", "--", path}},
	}
	run, err := runner.Start(t.Context(), worker.Assignment{Session: event.NewID(), Workdir: workspace,
		Claim: task.Claim{ID: event.NewID()}, SandboxProfile: sandbox.Profile{WriteAllow: []string{workspace}, Protect: []string{path}, EnvAllow: []string{"SystemRoot"}},
	})
	if err != nil {
		t.Fatal(err)
	}
	report, runErr := run.Wait(t.Context())
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
}

func TestProtectionChild(t *testing.T) {
	for i, argument := range os.Args {
		if argument != "--" || i+1 >= len(os.Args) {
			continue
		}
		if err := os.WriteFile(os.Args[i+1], []byte("modified"), 0600); err != nil {
			fmt.Fprintln(os.Stderr, err)
			os.Exit(1)
		}
		fmt.Print("finished")
		os.Exit(0)
	}
}
