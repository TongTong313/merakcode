//go:build windows && sandbox_integration

package worker_test

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"golang.org/x/sys/windows"

	"github.com/TongTong313/merakcode/merak/engine/agent"
	"github.com/TongTong313/merakcode/merak/engine/event"
	"github.com/TongTong313/merakcode/merak/engine/store/memory"
	"github.com/TongTong313/merakcode/merak/engine/worker"
	"github.com/TongTong313/merakcode/merak/engine/worker/claudecode"
	"github.com/TongTong313/merakcode/merak/internal/platform/sandbox"
)

func TestWindowsClaudeNewStateAndMigratedConfigurationArePrivate(t *testing.T) {
	state := os.Getenv("MERAKCODE_SANDBOX_TEST_STATE")
	if state == "" {
		t.Fatal("initialize the isolated test account pool")
	}
	home, workspace := t.TempDir(), t.TempDir()
	t.Setenv("USERPROFILE", home)
	t.Setenv("CLAUDE_CONFIG_DIR", "")
	if err := os.WriteFile(filepath.Join(home, ".claude.json"), []byte("legacy configuration"), 0600); err != nil {
		t.Fatal(err)
	}
	launcher := &sandbox.Launcher{StateDir: state}
	defer launcher.Close()
	configuration := filepath.Join(home, ".claude", ".claude.json")
	runner := &claudecode.Runner{Sandbox: launcher, Bus: event.NewBus(memory.New(), time.Now, event.NewID),
		Product: agent.Product{Binary: os.Args[0], Args: []string{"--merak-worker-fixture", "claude-code", configuration, "--initial-state", "legacy configuration"}}}
	run, err := runner.Start(t.Context(), worker.Assignment{Session: event.NewID(), Workdir: workspace, SandboxProfile: sandbox.Profile{WriteAllow: []string{workspace}}})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := run.Wait(t.Context()); err != nil {
		for _, path := range []string{filepath.Dir(configuration), configuration} {
			if descriptor, checkErr := windows.GetNamedSecurityInfo(path, windows.SE_FILE_OBJECT, windows.DACL_SECURITY_INFORMATION); checkErr == nil {
				t.Logf("state permissions during claim: path=%s permissions=%s", path, descriptor.String())
			}
		}
		t.Fatal(err)
	}
	if err := launcher.Close(); err != nil {
		t.Fatal(err)
	}
	owner, err := windows.GetCurrentProcessToken().GetTokenUser()
	if err != nil {
		t.Fatal(err)
	}
	for _, path := range []string{filepath.Join(home, ".claude"), filepath.Join(home, ".claude", ".claude.json")} {
		descriptor, err := windows.GetNamedSecurityInfo(path, windows.SE_FILE_OBJECT, windows.DACL_SECURITY_INFORMATION)
		if err != nil {
			t.Fatalf("state permissions: path=%s error=%v", path, err)
		}
		control, _, err := descriptor.Control()
		if err != nil || control&windows.SE_DACL_PROTECTED == 0 || strings.Count(descriptor.String(), "(") != 1 || !strings.Contains(descriptor.String(), ";;;"+owner.User.Sid.String()+")") {
			t.Errorf("state is not owner-only: path=%s permissions=%s error=%v", path, descriptor.String(), err)
		}
	}
}
