//go:build windows && sandbox_integration

package engine_test

import (
	"context"
	"fmt"
	"os"
	"os/exec"
	"os/user"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/TongTong313/merakcode/merak/engine"
	"github.com/TongTong313/merakcode/merak/engine/agent"
	"github.com/TongTong313/merakcode/merak/engine/event"
	"github.com/TongTong313/merakcode/merak/engine/permission"
	"github.com/TongTong313/merakcode/merak/engine/worker"
	"github.com/TongTong313/merakcode/merak/internal/platform/sandbox"
)

func init() {
	if len(os.Args) == 4 && os.Args[1] == "--merak-crashed-lease-fixture" {
		launcher := &sandbox.Launcher{StateDir: os.Args[2]}
		if _, err := launcher.Command(context.Background(), sandbox.Profile{WriteAllow: []string{os.Args[3]}}, os.Args[0]); err != nil {
			fmt.Fprintln(os.Stderr, err)
			os.Exit(1)
		}
		os.Exit(0)
	}
	if len(os.Args) == 2 && os.Args[1] == "--merak-session-account-fixture" {
		account, err := user.Current()
		if err != nil {
			os.Exit(1)
		}
		fmt.Print(account.Username)
		os.Exit(0)
	}
}

func TestWindowsEngineStartupRemovesAbandonedClaimAccess(t *testing.T) {
	state := os.Getenv("MERAKCODE_SANDBOX_TEST_STATE")
	if state == "" {
		t.Fatal("initialize the isolated test account pool")
	}
	workspace := t.TempDir()
	if out, err := exec.Command(os.Args[0], "--merak-crashed-lease-fixture", state, workspace).CombinedOutput(); err != nil {
		t.Fatalf("crashed claim fixture: %v %s", err, out)
	}
	before, err := exec.Command("icacls", workspace).CombinedOutput()
	if err != nil || !strings.Contains(string(before), "merak-sbx-") {
		t.Fatalf("claim did not leave its access rule: path=%s error=%v output=%s", workspace, err, before)
	}
	e, err := engine.New(engine.Deps{SandboxStateDir: state, Workdir: workspace})
	if err != nil {
		t.Fatal(err)
	}
	defer e.Close()
	after, err := exec.Command("icacls", workspace).CombinedOutput()
	if err != nil || strings.Contains(string(after), "merak-sbx-") {
		t.Fatalf("abandoned claim access survived engine startup: path=%s error=%v output=%s", workspace, err, after)
	}
}

func TestWindowsEngineReclaimsTheOldestIdleSessionAndResumesIt(t *testing.T) {
	state := os.Getenv("MERAKCODE_SANDBOX_TEST_STATE")
	if state == "" {
		t.Fatal("initialize the isolated two-account test pool")
	}
	t.Setenv("USERPROFILE", t.TempDir())
	workspace := t.TempDir()
	ctx, cancel := context.WithTimeout(t.Context(), 15*time.Second)
	defer cancel()
	e, err := engine.New(engine.Deps{SandboxStateDir: state, Workdir: workspace, Ask: func(context.Context, permission.Request) (permission.Reply, error) {
		t.Error("account network enforcement must not request unrestricted startup")
		return permission.Reply{Decision: permission.Deny}, nil
	}})
	if err != nil {
		t.Fatal(err)
	}
	defer e.Close()
	p := agent.DefaultMerakCode()
	p.Product = &agent.Product{Kind: worker.KindCommand, Binary: os.Args[0], Args: []string{"--merak-session-account-fixture"}}
	runSession := func(id event.ID) string {
		t.Helper()
		run, err := e.StartWorker(ctx, p, worker.Assignment{Session: id, Workdir: workspace})
		if err != nil {
			t.Fatal(err)
		}
		report, err := run.Wait(ctx)
		if err != nil {
			t.Fatalf("session %s: %v", id, err)
		}
		if !strings.Contains(report.Summary, "merak-sbx-") {
			t.Fatalf("session %s ran outside the account pool: %+v", id, report)
		}
		return report.Summary
	}
	first := runSession("first")
	if again := runSession("first"); again != first {
		t.Fatalf("idle account was returned before pool exhaustion: %q -> %q", first, again)
	}
	second := runSession("second")
	if second == first {
		t.Fatal("the second session reclaimed an account while another account was free")
	}
	if third := runSession("third"); third != first {
		t.Fatalf("new session did not reclaim the oldest idle account: %q, expected %q", third, first)
	}
	if resumed := runSession("first"); resumed != second {
		t.Fatalf("resumed session did not lease the next oldest idle account: %q, expected %q", resumed, second)
	}
}

func TestWindowsEngineSharesAndReturnsTheSessionAccount(t *testing.T) {
	state := os.Getenv("MERAKCODE_SANDBOX_TEST_STATE")
	if state == "" {
		t.Fatal("initialize the isolated test account pool and set MERAKCODE_SANDBOX_TEST_STATE")
	}
	t.Setenv("USERPROFILE", t.TempDir())
	workspace := t.TempDir()
	ctx, cancel := context.WithTimeout(t.Context(), 20*time.Second)
	defer cancel()
	e, err := engine.New(engine.Deps{SandboxStateDir: state, Workdir: workspace})
	if err != nil {
		t.Fatal(err)
	}
	defer e.Close()
	if status, err := e.SandboxStatus(ctx, workspace, permission.ModeAsk); err != nil || !status.Available {
		t.Fatalf("engine sandbox status=%+v error=%v", status, err)
	}
	p := agent.DefaultMerakCode()
	path := filepath.Join(workspace, "ordinary.txt")
	p.Product = &agent.Product{Kind: worker.KindCommand, Binary: os.Args[0], Args: []string{"--merak-protection-event-fixture", path}}
	for range 3 {
		run, err := e.StartWorker(ctx, p, worker.Assignment{Session: "same-session", Workdir: workspace})
		if err != nil {
			t.Fatal(err)
		}
		if _, err := run.Wait(ctx); err != nil {
			t.Fatal(err)
		}
	}
	if body, err := os.ReadFile(path); err != nil || string(body) != "modified" {
		t.Fatalf("member write=%q error=%v", body, err)
	}
	if err := e.Close(); err != nil {
		t.Fatal(err)
	}
	var leases []*sandbox.Launcher
	defer func() {
		for _, lease := range leases {
			if err := lease.Close(); err != nil {
				t.Error(err)
			}
		}
	}()
	for range 2 {
		lease := &sandbox.Launcher{StateDir: state}
		leases = append(leases, lease)
		if _, err := lease.Command(ctx, sandbox.Profile{WriteAllow: []string{t.TempDir()}}, os.Args[0]); err != nil {
			t.Fatal(err)
		}
	}
}
