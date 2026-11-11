//go:build !windows

package pi_test

import (
	"bufio"
	"context"
	"fmt"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/TongTong313/merakcode/merak/engine/agent"
	"github.com/TongTong313/merakcode/merak/engine/event"
	"github.com/TongTong313/merakcode/merak/engine/store/memory"
	"github.com/TongTong313/merakcode/merak/engine/task"
	"github.com/TongTong313/merakcode/merak/engine/worker"
	"github.com/TongTong313/merakcode/merak/engine/worker/pi"
	"github.com/TongTong313/merakcode/merak/internal/platform/sandbox"
)

func init() {
	if os.Getenv("MERAKCODE_PI_MCP_PATH_FIXTURE") != "1" {
		return
	}
	if !bufio.NewScanner(os.Stdin).Scan() {
		os.Exit(1)
	}
	fmt.Fprintln(os.Stdout, `{"type":"agent_settled"}`)
	os.Exit(0)
}

func TestPiMCPAcceptsASymlinkTemporaryDirectory(t *testing.T) {
	root, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	link := filepath.Join(root, "temporary-link")
	real := filepath.Join(root, "temporary-real")
	if err := os.Mkdir(real, 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(real, link); err != nil {
		t.Fatal(err)
	}
	t.Setenv("TMPDIR", link)
	t.Setenv("HOME", root)
	launcher := new(sandbox.Launcher)
	defer launcher.Close()
	ctx, cancel := context.WithTimeout(t.Context(), 10*time.Second)
	defer cancel()
	policy := sandbox.Profile{WriteAllow: []string{root}, EnvAllow: []string{"MERAKCODE_PI_MCP_PATH_FIXTURE"}, Network: sandbox.Network{Mode: "off"}}
	if !launcher.Status(ctx, policy).Available {
		t.Skip("sandbox unavailable")
	}
	binary, _ := os.Executable()
	runner := pi.Runner{Sandbox: launcher, Bus: event.NewBus(memory.New(), time.Now, event.NewID), Product: agent.Product{Binary: binary, Env: map[string]string{"MERAKCODE_PI_MCP_PATH_FIXTURE": "1"}}}
	run, err := runner.Start(ctx, worker.Assignment{Session: "session", Workdir: root, Packet: "Begin", Claim: task.Claim{Member: "member"}, MCP: &worker.MCPConfig{Command: "unused"}, SandboxProfile: policy})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := run.Wait(ctx); err != nil {
		t.Fatal(err)
	}
}
