package process_test

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"testing"
	"time"

	"github.com/TongTong313/merakcode/merak/engine/infra/process"
)

func TestCommandPreservesExecutableResolution(t *testing.T) {
	workdir, bindir := t.TempDir(), t.TempDir()
	t.Chdir(workdir)
	t.Setenv("PATH", bindir)
	t.Setenv("PATHEXT", ".EXE;.CMD")
	t.Setenv("GODEBUG", "execerrdot=1")
	t.Setenv("NoDefaultCurrentDirectoryInExePath", "")
	if err := os.Unsetenv("NoDefaultCurrentDirectoryInExePath"); err != nil {
		t.Fatal(err)
	}
	executable := filepath.Join(bindir, "program.exe")
	for _, name := range []string{executable, filepath.Join(workdir, "local.exe")} {
		if err := os.WriteFile(name, []byte("lookup fixture"), 0600); err != nil {
			t.Fatal(err)
		}
	}
	relative, err := filepath.Rel(workdir, executable)
	if err != nil {
		t.Fatal(err)
	}
	for _, tc := range []struct {
		name, executable, path string
		lookupError            error
	}{
		{"bare name", "program", executable, nil},
		{"bare name with extension", "program.exe", executable, nil},
		{"absolute path", executable, executable, nil},
		{"relative path", relative, relative, nil},
		{"missing executable", "missing-program", "missing-program", exec.ErrNotFound},
		{"implicit current directory", "local", "local.exe", exec.ErrDot},
	} {
		t.Run(tc.name, func(t *testing.T) {
			args := []string{"space inside", "x&echo altered"}
			cmd := process.Command(context.Background(), workdir, tc.executable, args...)
			if !errors.Is(cmd.Err, tc.lookupError) {
				t.Fatalf("lookup error=%v, want %v", cmd.Err, tc.lookupError)
			}
			if cmd.Path != tc.path {
				t.Fatalf("path=%q, want %q", cmd.Path, tc.path)
			}
			if !reflect.DeepEqual(cmd.Args, append([]string{tc.executable}, args...)) {
				t.Fatal("command arguments changed")
			}
			if cmd.Dir != workdir || cmd.WaitDelay != time.Second || cmd.Cancel == nil || cmd.SysProcAttr == nil || !cmd.SysProcAttr.HideWindow {
				t.Fatal("command process settings changed")
			}
		})
	}
}

func TestNpmShimsWithoutAnExtensionPreserveArguments(t *testing.T) {
	dir, workdir := t.TempDir(), t.TempDir()
	t.Chdir(workdir)
	t.Setenv("PATH", dir+string(os.PathListSeparator)+os.Getenv("PATH"))
	t.Setenv("PATHEXT", ".EXE;.CMD")
	script := filepath.Join(dir, "program.js")
	if err := os.WriteFile(script, []byte(`process.stdout.write(JSON.stringify(process.argv.slice(2)))`), 0600); err != nil {
		t.Fatal(err)
	}
	body := "@ECHO off\r\nSET dp0=%~dp0\r\nSET \"_prog=node\"\r\n\"%_prog%\" \"%dp0%\\program.js\" %*\r\n"
	for _, shim := range []string{"program.cmd", "program.custom.cmd"} {
		if err := os.WriteFile(filepath.Join(dir, shim), []byte(body), 0600); err != nil {
			t.Fatal(err)
		}
	}
	absolute := filepath.Join(dir, "program")
	relative, err := filepath.Rel(workdir, absolute)
	if err != nil {
		t.Fatal(err)
	}
	for _, tc := range []struct{ name, executable string }{
		{"absolute path", absolute},
		{"relative path", relative},
		{"bare name", "program"},
		{"absolute extension fallback", filepath.Join(dir, "program.custom")},
	} {
		t.Run(tc.name, func(t *testing.T) {
			ctx, cancel := context.WithTimeout(t.Context(), 10*time.Second)
			defer cancel()
			args := []string{"space inside", "quoted\"value", "%PATH%", "x&echo altered", "line\nbreak"}
			cmd := process.Command(ctx, workdir, tc.executable, args...)
			body, err := cmd.Output()
			if err != nil {
				t.Fatal(err)
			}
			var got []string
			if err := json.Unmarshal(body, &got); err != nil {
				t.Fatal(err)
			}
			if !reflect.DeepEqual(got, args) {
				t.Fatal("shim arguments changed")
			}
		})
	}
}
