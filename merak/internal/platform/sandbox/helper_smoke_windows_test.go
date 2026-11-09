//go:build windows && sandbox_integration

package sandbox_test

import (
	"context"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/TongTong313/merakcode/merak/internal/platform/pty"
	"github.com/TongTong313/merakcode/merak/internal/platform/sandbox"
)

func TestWindowsSandboxHelperRunsNodeAndGitWithPipesAndConPTY(t *testing.T) {
	state := os.Getenv("MERAKCODE_SANDBOX_TEST_STATE")
	if state == "" {
		t.Fatal("initialize the isolated test account pool and set MERAKCODE_SANDBOX_TEST_STATE")
	}

	node, err := exec.LookPath("node")
	if err != nil {
		t.Fatal(err)
	}
	git, err := exec.LookPath("git")
	if err != nil {
		t.Fatal(err)
	}
	for _, terminal := range []bool{false, true} {
		name := "pipes"
		if terminal {
			name = "ConPTY"
		}
		t.Run(name, func(t *testing.T) {
			ctx, cancel := context.WithTimeout(t.Context(), 15*time.Second)
			defer cancel()
			workspace := t.TempDir()
			const script = `require('node:readline').createInterface({input:process.stdin}).once('line', line => {
const fs = require('node:fs'); fs.writeFileSync('node.txt',line);
const git = require('node:child_process').spawnSync(process.argv[1],['init','--quiet','repo'],{encoding:'utf8'});
if(git.status !== 0) {
 const diagnostic = {status:git.status,error:git.error?.code,stderr:git.stderr};
 fs.writeFileSync('git-error.txt',JSON.stringify(diagnostic)); process.exit(23);
}
fs.writeFileSync('git.txt',fs.readFileSync('repo/.git/HEAD','utf8'));
process.exit(0);
});`
			launcher := &sandbox.Launcher{StateDir: state}
			t.Cleanup(func() {
				if err := launcher.Close(); err != nil {
					t.Error(err)
				}
			})
			command, err := launcher.Command(ctx, sandbox.Profile{WriteAllow: []string{workspace}, EnvAllow: []string{"SystemRoot", "PATH"}}, node, "-e", script, git)
			if err != nil {
				t.Fatal(err)
			}
			command.Dir = workspace
			var code int
			var runErr error
			var output strings.Builder
			if terminal {
				p, err := pty.Start(pty.Options{Command: command.Path, Args: command.Args[1:], Directory: workspace, Env: command.Env})
				if err != nil {
					t.Fatal(err)
				}
				t.Cleanup(func() { p.Close() })
				drained := make(chan struct{})
				go func() { io.Copy(&output, p); close(drained) }()
				if _, err := p.Write([]byte("standard input\r\n")); err != nil {
					t.Fatal(err)
				}
				code, runErr = p.Wait(ctx)
				p.Close()
				<-drained
			} else {
				command.Stdin = strings.NewReader("standard input\n")
				command.Stdout, command.Stderr = &output, &output
				runErr = command.Run()
				if command.ProcessState != nil {
					code = command.ProcessState.ExitCode()
				}
			}
			if code != 0 || runErr != nil {
				diagnostic, _ := os.ReadFile(filepath.Join(workspace, "git-error.txt"))
				t.Fatalf("member code=%d error=%v output=%s git=%s", code, runErr, output.String(), diagnostic)
			}
			body, err := os.ReadFile(filepath.Join(workspace, "node.txt"))
			if err != nil || string(body) != "standard input" {
				t.Fatalf("node stdin=%q error=%v", body, err)
			}
			body, err = os.ReadFile(filepath.Join(workspace, "git.txt"))
			if err != nil || !strings.HasPrefix(string(body), "ref: refs/heads/") {
				t.Fatalf("git HEAD=%q error=%v", body, err)
			}
		})
	}
}
