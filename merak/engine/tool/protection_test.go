package tool_test

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"

	"github.com/TongTong313/merakcode/merak/engine/tool"
	"github.com/TongTong313/merakcode/merak/internal/platform/sandbox"
)

func protectedFailureCode() string {
	if runtime.GOOS == "darwin" {
		return "MRK-5009"
	}
	return "MRK-5007"
}

func TestBashRestoresProtectedFilesAndReportsTheChangedPath(t *testing.T) {
	workspace, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	protected := filepath.Join(workspace, "merakcode.json")
	if err := os.WriteFile(protected, []byte("original"), 0600); err != nil {
		t.Fatal(err)
	}
	launcher := &sandbox.Launcher{Unavailable: func(context.Context, sandbox.Status) error { return nil }}
	t.Cleanup(func() {
		if err := launcher.Close(); err != nil {
			t.Error(err)
		}
	})
	input, _ := json.Marshal(map[string]string{"command": "printf changed > merakcode.json; printf retained > normal.txt"})
	result, err := (tool.Bash{}).Run(t.Context(), tool.Call{Input: input, Env: tool.Env{
		Workdir: workspace, Sandbox: launcher,
		SandboxProfile: sandbox.Profile{WriteAllow: []string{workspace}, Protect: []string{protected}, EnvAllow: []string{"PATH", "SystemRoot"}},
	}})
	if err != nil {
		t.Fatal(err)
	}
	body, err := os.ReadFile(protected)
	if err != nil || string(body) != "original" {
		t.Fatalf("protected contents = %q, error = %v", body, err)
	}
	ordinary, err := os.ReadFile(filepath.Join(workspace, "normal.txt"))
	if err != nil || string(ordinary) != "retained" {
		t.Fatalf("ordinary contents = %q, error = %v", ordinary, err)
	}
	view, err := json.Marshal(result)
	if err != nil || !result.IsError || result.Code != protectedFailureCode() || !strings.Contains(string(view), "merakcode.json") {
		t.Fatalf("protection result = %s, error = %v", view, err)
	}
}

func TestCancelledBackgroundBashRestoresProtectionAndReportsIt(t *testing.T) {
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
	jobs := new(tool.Jobs)
	defer jobs.Close()
	env := tool.Env{Workdir: workspace, Sandbox: launcher, Jobs: jobs,
		SandboxProfile: sandbox.Profile{WriteAllow: []string{workspace}, Protect: []string{path}, EnvAllow: []string{"PATH", "SystemRoot"}},
	}
	ctx, cancel := context.WithTimeout(t.Context(), 10*time.Second)
	defer cancel()
	result, err := (tool.Bash{}).Run(ctx, tool.Call{Input: []byte(`{"command":"printf changed > merakcode.json; printf ready; sleep 30","background":true}`), Env: env})
	if err != nil || result.IsError || result.JobID == "" {
		t.Fatalf("start=%+v error=%v", result, err)
	}
	query, _ := json.Marshal(map[string]string{"id": result.JobID})
	for {
		output, err := (tool.BashOutput{}).Run(ctx, tool.Call{Input: query, Env: env})
		if err != nil {
			t.Fatal(err)
		}
		if len(output.Parts) != 0 && strings.Contains(output.Parts[0].Text, "ready") {
			break
		}
		select {
		case <-ctx.Done():
			t.Fatal(ctx.Err())
		case <-time.After(10 * time.Millisecond):
		}
	}
	jobs.Close()
	body, err := os.ReadFile(path)
	if err != nil || string(body) != "original" {
		t.Fatalf("protected file=%q error=%v", body, err)
	}
	output, err := (tool.BashOutput{}).Run(ctx, tool.Call{Input: query, Env: env})
	if err != nil || output.Running || !output.IsError || output.Code != protectedFailureCode() || !strings.Contains(output.Parts[0].Text, "merakcode.json") {
		t.Fatalf("output=%+v error=%v", output, err)
	}
}

func TestBashRestoresChangesAdditionsAndDeletionsInProtectedDirectories(t *testing.T) {
	workspace, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	protected := filepath.Join(workspace, "hooks")
	if err := os.Mkdir(protected, 0700); err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{"changed", "deleted", "retained"} {
		if err := os.WriteFile(filepath.Join(protected, name), []byte("original "+name), 0600); err != nil {
			t.Fatal(err)
		}
	}
	retained, err := os.Stat(filepath.Join(protected, "retained"))
	if err != nil {
		t.Fatal(err)
	}
	launcher := &sandbox.Launcher{Unavailable: func(context.Context, sandbox.Status) error { return nil }}
	t.Cleanup(func() {
		if err := launcher.Close(); err != nil {
			t.Error(err)
		}
	})
	input, _ := json.Marshal(map[string]string{"command": "printf modified > hooks/changed; rm hooks/deleted; mkdir hooks/added; printf new > hooks/added/file"})
	result, err := (tool.Bash{}).Run(t.Context(), tool.Call{Input: input, Env: tool.Env{
		Workdir: workspace, Sandbox: launcher,
		SandboxProfile: sandbox.Profile{WriteAllow: []string{workspace}, Protect: []string{protected}, EnvAllow: []string{"PATH", "SystemRoot"}},
	}})
	if err != nil || !result.IsError || result.Code != protectedFailureCode() {
		t.Fatalf("result=%+v error=%v", result, err)
	}
	for _, name := range []string{"changed", "deleted", "retained"} {
		body, err := os.ReadFile(filepath.Join(protected, name))
		if err != nil || string(body) != "original "+name {
			t.Fatalf("%s = %q, %v", name, body, err)
		}
	}
	if _, err := os.Stat(filepath.Join(protected, "added")); !os.IsNotExist(err) {
		t.Fatalf("added directory survived: %v", err)
	}
	unchanged, err := os.Stat(filepath.Join(protected, "retained"))
	if err != nil || !os.SameFile(retained, unchanged) || !retained.ModTime().Equal(unchanged.ModTime()) {
		t.Fatalf("rollback replaced an unchanged protected file: path=%s error=%v", filepath.Join(protected, "retained"), err)
	}
	view, _ := json.Marshal(result)
	for _, name := range []string{"changed", "deleted", "added"} {
		if !strings.Contains(string(view), name) {
			t.Fatalf("missing path %q in %s", name, view)
		}
	}
}
