//go:build windows && sandbox_integration

package sandbox_test

import (
	"context"
	"encoding/json"
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

func TestWindowsSandboxMemberReceivesConPTYInput(t *testing.T) {
	state := os.Getenv("MERAKCODE_SANDBOX_TEST_STATE")
	if state == "" {
		t.Fatal("initialize the isolated test account pool and set MERAKCODE_SANDBOX_TEST_STATE")
	}
	node, err := exec.LookPath("node")
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(t.Context(), 8*time.Second)
	defer cancel()
	workspace := t.TempDir()
	launcher := &sandbox.Launcher{StateDir: state}
	t.Cleanup(func() {
		if err := launcher.Close(); err != nil {
			t.Error(err)
		}
	})
	const script = `require('node:readline').createInterface({input:process.stdin}).once('line',line=>{
require('node:fs').writeFileSync('console.json',JSON.stringify({input:line,tty:process.stdin.isTTY===true}));process.exit(0);
});`
	command, err := launcher.Command(ctx, sandbox.Profile{WriteAllow: []string{workspace}, EnvAllow: []string{"SystemRoot", "PATH"}}, node, "-e", script)
	if err != nil {
		t.Fatal(err)
	}
	terminal, err := pty.Start(pty.Options{Command: command.Path, Args: command.Args[1:], Directory: workspace, Env: command.Env})
	if err != nil {
		t.Fatal(err)
	}
	defer terminal.Close()
	var output strings.Builder
	drained := make(chan struct{})
	go func() { io.Copy(&output, terminal); close(drained) }()
	if _, err := terminal.Write([]byte("console input\r\n")); err != nil {
		t.Fatal(err)
	}
	code, err := terminal.Wait(ctx)
	terminal.Close()
	<-drained
	if err != nil || code != 0 {
		t.Fatalf("member code=%d error=%v output=%s", code, err, output.String())
	}
	body, err := os.ReadFile(filepath.Join(workspace, "console.json"))
	if err != nil {
		t.Fatal(err)
	}
	var result struct {
		Input string
		TTY   bool
	}
	if err := json.Unmarshal(body, &result); err != nil {
		t.Fatal(err)
	}
	if result.Input != "console input" || !result.TTY {
		t.Fatalf("console result=%+v", result)
	}
}
