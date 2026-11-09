package worker_test

import (
	"context"
	"os"
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
	"github.com/TongTong313/merakcode/merak/engine/worker/acp"
	"github.com/TongTong313/merakcode/merak/engine/worker/claudecode"
	"github.com/TongTong313/merakcode/merak/engine/worker/codex"
	"github.com/TongTong313/merakcode/merak/engine/worker/command"
	"github.com/TongTong313/merakcode/merak/engine/worker/opencode"
	"github.com/TongTong313/merakcode/merak/engine/worker/pi"
	"github.com/TongTong313/merakcode/merak/internal/platform/sandbox"
)

func TestSandboxExternalWorkerWrites(t *testing.T) {
	for _, kind := range []string{"codex", "pi", "acp", "opencode", "claude-code"} {
		t.Run(kind, func(t *testing.T) { checkExternalWorkerSandboxWrites(t, kind) })
	}
}

func TestSandboxExternalWorkerCanWriteItsOwnProductState(t *testing.T) {
	for _, test := range []struct{ kind, state string }{
		{"codex", ".codex/session"}, {"pi", ".pi/session"},
		{"claude-code", ".claude/session"}, {"claude-code", ".claude/.claude.json"},
		{"opencode", ".config/opencode/session"}, {"opencode", ".local/share/opencode/session"},
	} {
		t.Run(test.kind+"/"+test.state, func(t *testing.T) {
			home, workspace := t.TempDir(), t.TempDir()
			t.Setenv("HOME", home)
			path := filepath.Join(home, test.state)
			if err := os.MkdirAll(filepath.Dir(path), 0700); err != nil {
				t.Fatal(err)
			}
			if err := os.WriteFile(path, []byte("initial"), 0600); err != nil {
				t.Fatal(err)
			}
			launcher := new(sandbox.Launcher)
			defer launcher.Close()
			bus := event.NewBus(memory.New(), time.Now, event.NewID)
			product := profile.Product{Kind: worker.Kind(test.kind), Binary: os.Args[0], Args: []string{"--merak-worker-fixture", test.kind, path}}
			var runner worker.Runner
			switch test.kind {
			case "codex":
				runner = &codex.Runner{Bus: bus, Sandbox: launcher, Product: product}
			case "pi":
				runner = &pi.Runner{Bus: bus, Sandbox: launcher, Product: product}
			case "claude-code":
				runner = &claudecode.Runner{Bus: bus, Sandbox: launcher, Product: product}
			case "opencode":
				runner = &opencode.Runner{Bus: bus, Sandbox: launcher, Product: product}
			}
			run, err := runner.Start(t.Context(), worker.Assignment{Session: event.NewID(), Workdir: workspace, SandboxProfile: sandbox.Profile{WriteAllow: []string{workspace}}})
			if err != nil {
				t.Fatal(err)
			}
			if report, err := run.Wait(t.Context()); err != nil || report.Verdict != task.VerdictDone {
				t.Fatalf("own product state: %+v %v", report, err)
			}
			if body, err := os.ReadFile(path); err != nil || string(body) != "worker output" {
				t.Fatalf("state=%q error=%v", body, err)
			}
		})
	}
}

func TestSandboxExternalWorkerCreatesItsOwnStateDirectoryOnFirstLaunch(t *testing.T) {
	home, workspace := t.TempDir(), t.TempDir()
	t.Setenv("HOME", home)
	path := filepath.Join(home, ".codex", "session")
	launcher := new(sandbox.Launcher)
	defer launcher.Close()
	bus := event.NewBus(memory.New(), time.Now, event.NewID)
	product := profile.Product{Binary: os.Args[0], Args: []string{"--merak-worker-fixture", "codex", path}}
	runner := &codex.Runner{Bus: bus, Sandbox: launcher, Product: product}
	run, err := runner.Start(t.Context(), worker.Assignment{Session: event.NewID(), Workdir: workspace, SandboxProfile: sandbox.Profile{WriteAllow: []string{workspace}}})
	if err != nil {
		t.Fatal(err)
	}
	if report, err := run.Wait(t.Context()); err != nil || report.Verdict != task.VerdictDone {
		t.Fatalf("first launch: %+v %v", report, err)
	}
	if body, err := os.ReadFile(path); err != nil || string(body) != "worker output" {
		t.Fatalf("product state=%q error=%v", body, err)
	}
}

func TestSandboxExternalWorkerKeepsTheRealUserProfile(t *testing.T) {
	home, workspace := t.TempDir(), t.TempDir()
	t.Setenv("HOME", home)
	launcher := new(sandbox.Launcher)
	defer launcher.Close()
	bus := event.NewBus(memory.New(), time.Now, event.NewID)
	product := profile.Product{Binary: os.Args[0], Args: []string{"--merak-worker-fixture", "codex", filepath.Join(workspace, "output"), "--real-home", home}}
	runner := &codex.Runner{Bus: bus, Sandbox: launcher, Product: product}
	run, err := runner.Start(t.Context(), worker.Assignment{Session: event.NewID(), Workdir: workspace, SandboxProfile: sandbox.Profile{WriteAllow: []string{workspace}}})
	if err != nil {
		t.Fatal(err)
	}
	if report, err := run.Wait(t.Context()); err != nil || report.Verdict != task.VerdictDone {
		t.Fatalf("real user profile: %+v %v", report, err)
	}
}

func TestSandboxExternalWorkerMigratesClaudeStateWithoutChangingTheOriginal(t *testing.T) {
	for _, test := range []struct {
		name             string
		custom, existing bool
	}{
		{"default directory migration", false, false}, {"keeps existing copy", false, true}, {"user configured directory", true, false},
	} {
		t.Run(test.name, func(t *testing.T) {
			home, workspace := t.TempDir(), t.TempDir()
			t.Setenv("HOME", home)
			original := filepath.Join(home, ".claude.json")
			if err := os.WriteFile(original, []byte("user configuration"), 0600); err != nil {
				t.Fatal(err)
			}
			directory := filepath.Join(home, ".claude")
			if test.custom {
				directory = filepath.Join(home, "custom-claude")
			}
			path := filepath.Join(directory, ".claude.json")
			expected := "user configuration"
			if test.existing {
				if err := os.MkdirAll(directory, 0700); err != nil {
					t.Fatal(err)
				}
				expected = "existing copy"
				if err := os.WriteFile(path, []byte(expected), 0600); err != nil {
					t.Fatal(err)
				}
			}
			launcher := new(sandbox.Launcher)
			defer launcher.Close()
			bus := event.NewBus(memory.New(), time.Now, event.NewID)
			product := profile.Product{Binary: os.Args[0], Args: []string{"--merak-worker-fixture", "claude-code", path, "--initial-state", expected}}
			if test.custom {
				product.Env = map[string]string{"CLAUDE_CONFIG_DIR": directory}
			}
			runner := &claudecode.Runner{Bus: bus, Sandbox: launcher, Product: product}
			run, err := runner.Start(t.Context(), worker.Assignment{Session: event.NewID(), Workdir: workspace, SandboxProfile: sandbox.Profile{WriteAllow: []string{workspace}}})
			if err != nil {
				t.Fatal(err)
			}
			if report, err := run.Wait(t.Context()); err != nil || report.Verdict != task.VerdictDone {
				t.Fatalf("Claude state preparation: %+v %v", report, err)
			}
			if body, err := os.ReadFile(original); err != nil || string(body) != "user configuration" {
				t.Fatalf("original configuration changed: %q %v", body, err)
			}
		})
	}
}

func TestSandboxExternalWorkerRejectsAClaudeStateAliasToTheUserHome(t *testing.T) {
	home, workspace := t.TempDir(), t.TempDir()
	t.Setenv("HOME", home)
	alias := filepath.Join(workspace, "state-alias")
	if err := os.Symlink(home, alias); err != nil {
		t.Fatal(err)
	}
	marker := filepath.Join(home, "outside-state")
	launcher := new(sandbox.Launcher)
	defer launcher.Close()
	runner := &claudecode.Runner{Bus: event.NewBus(memory.New(), time.Now, event.NewID), Sandbox: launcher, Product: profile.Product{Binary: os.Args[0], Args: []string{"--merak-worker-fixture", "claude-code", marker}, Env: map[string]string{"CLAUDE_CONFIG_DIR": alias}}}
	run, err := runner.Start(t.Context(), worker.Assignment{Session: event.NewID(), Workdir: workspace, SandboxProfile: sandbox.Profile{WriteAllow: []string{workspace}}})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := run.Wait(t.Context()); err == nil {
		t.Fatalf("Claude state alias authorized the user home: %s -> %s", alias, home)
	}
	if _, err := os.Stat(marker); !os.IsNotExist(err) {
		t.Fatalf("member wrote outside its state directory: path=%s error=%v", marker, err)
	}
}

func TestSandboxExternalWorkerPublishesOnlyACompleteClaudeConfiguration(t *testing.T) {
	home, workspace := t.TempDir(), t.TempDir()
	t.Setenv("HOME", home)
	source := filepath.Join(home, ".claude.json")
	if err := syscall.Mkfifo(source, 0600); err != nil {
		t.Fatal(err)
	}
	prefix := `{"fixture":"` + strings.Repeat("x", 1<<20)
	ready, release := make(chan error, 1), make(chan struct{})
	defer close(release)
	go func() {
		file, err := os.OpenFile(source, os.O_WRONLY, 0)
		if err != nil {
			ready <- err
			return
		}
		defer file.Close()
		_, err = file.WriteString(prefix)
		ready <- err
		<-release
		_, _ = file.WriteString(`"}`)
	}()
	launcher := new(sandbox.Launcher)
	defer launcher.Close()
	runner := &claudecode.Runner{Bus: event.NewBus(memory.New(), time.Now, event.NewID), Sandbox: launcher, Product: profile.Product{Binary: os.Args[0], Args: []string{"--merak-worker-fixture", "claude-code", filepath.Join(workspace, "completed")}}}
	run, err := runner.Start(t.Context(), worker.Assignment{Session: event.NewID(), Workdir: workspace, SandboxProfile: sandbox.Profile{WriteAllow: []string{workspace}}})
	if err != nil {
		t.Fatal(err)
	}
	select {
	case err := <-ready:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("configuration copy did not start")
	}
	destination := filepath.Join(home, ".claude", ".claude.json")
	if _, err := os.Stat(destination); !os.IsNotExist(err) {
		t.Errorf("another member can read an incomplete configuration: path=%s error=%v", destination, err)
	}
	release <- struct{}{}
	if _, err := run.Wait(t.Context()); err != nil {
		t.Fatal(err)
	}
	if body, err := os.ReadFile(destination); err != nil || string(body) != prefix+`"}` {
		t.Fatalf("incomplete migrated configuration: path=%s bytes=%d error=%v", destination, len(body), err)
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

func TestSandboxExternalWorkerCannotReadOtherProductState(t *testing.T) {
	for _, test := range []struct{ kind, denied string }{
		{"codex", ".claude/token"}, {"pi", ".codex/token"}, {"claude-code", ".pi/token"},
		{"opencode", ".claude.json"}, {"acp", ".codex/token"}, {"command", ".codex/token"},
	} {
		t.Run(test.kind, func(t *testing.T) {
			home, workspace := t.TempDir(), t.TempDir()
			t.Setenv("HOME", home)
			denied := filepath.Join(home, test.denied)
			if err := os.MkdirAll(filepath.Dir(denied), 0700); err != nil {
				t.Fatal(err)
			}
			if err := os.WriteFile(denied, []byte("other product credential"), 0600); err != nil {
				t.Fatal(err)
			}
			marker := filepath.Join(workspace, "completed")
			launcher := new(sandbox.Launcher)
			defer launcher.Close()
			bus := event.NewBus(memory.New(), time.Now, event.NewID)
			product := profile.Product{Kind: worker.Kind(test.kind), Binary: os.Args[0], Args: []string{"--merak-worker-fixture", test.kind, marker, "--denied-state", denied}}
			var runner worker.Runner
			switch test.kind {
			case "codex":
				runner = &codex.Runner{Bus: bus, Sandbox: launcher, Product: product}
			case "pi":
				runner = &pi.Runner{Bus: bus, Sandbox: launcher, Product: product}
			case "claude-code":
				runner = &claudecode.Runner{Bus: bus, Sandbox: launcher, Product: product}
			case "opencode":
				runner = &opencode.Runner{Bus: bus, Sandbox: launcher, Product: product}
			case "acp":
				runner = &acp.Runner{Bus: bus, Sandbox: launcher, Product: product}
			case "command":
				runner = &command.Runner{Bus: bus, Sandbox: launcher, Product: product}
			}
			run, err := runner.Start(t.Context(), worker.Assignment{Session: event.NewID(), Workdir: workspace, SandboxProfile: sandbox.Profile{WriteAllow: []string{workspace}}})
			if err != nil {
				t.Fatal(err)
			}
			if report, err := run.Wait(t.Context()); err != nil || report.Verdict != task.VerdictDone {
				t.Fatalf("other product read was not denied: %+v %v", report, err)
			}
			if body, err := os.ReadFile(marker); err != nil || string(body) != "worker output" {
				t.Fatalf("completed=%q error=%v", body, err)
			}
		})
	}
}
