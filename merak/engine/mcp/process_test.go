package mcp_test

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"testing"
	"time"

	"github.com/TongTong313/merakcode/merak/engine/mcp"
	"github.com/TongTong313/merakcode/merak/engine/tool"
	"github.com/TongTong313/merakcode/merak/internal/platform/config"
	"github.com/TongTong313/merakcode/merak/internal/platform/sandbox"
	"github.com/TongTong313/merakcode/merak/protocol"
)

func TestMCPMemberFixtureProcess(t *testing.T) {
	if os.Getenv("MERAKCODE_MCP_MEMBER_FIXTURE") != "1" {
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	connection, err := protocol.ConnectMCP(ctx, os.Getenv("MERAKCODE_MCP_ADDRESS"), os.Getenv("MERAKCODE_MCP_TOKEN"), "worker", "claim")
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	client, err := mcp.Connect(ctx, "merak", connection, connection)
	if err == nil {
		_, err = client.Tools(ctx)
		client.Close()
	}
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	os.Exit(0)
}

func TestSandboxedMemberConnectsToItsGroupMCPPort(t *testing.T) {
	if runtime.GOOS != "linux" {
		t.Skip("requires Landlock")
	}
	ctx, cancel := context.WithTimeout(t.Context(), 15*time.Second)
	defer cancel()
	endpoint, err := mcp.Listen(ctx, &mcp.Server{Tools: tool.NewPool("fixture", tool.ReadFile{})}, "worker", "claim")
	if err != nil {
		t.Fatal(err)
	}
	defer endpoint.Close()
	launcher := new(sandbox.Launcher)
	defer launcher.Close()
	profile := sandbox.Profile{WriteAllow: []string{t.TempDir()}, Network: sandbox.Network{Mode: "off", LocalPorts: []int{endpoint.Port}}, EnvAllow: []string{"MERAKCODE_MCP_MEMBER_FIXTURE", "MERAKCODE_MCP_ADDRESS", "MERAKCODE_MCP_TOKEN"}}
	if !launcher.Status(ctx, profile).Available {
		t.Skip("sandbox unavailable")
	}
	command, _ := os.Executable()
	cmd, err := launcher.Command(ctx, profile, command, "-test.run=^TestMCPMemberFixtureProcess$")
	if err != nil {
		t.Fatal(err)
	}
	cmd.Env = append(cmd.Environ(), "MERAKCODE_MCP_MEMBER_FIXTURE=1", "MERAKCODE_MCP_ADDRESS="+endpoint.Address, "MERAKCODE_MCP_TOKEN="+endpoint.Token)
	var output bytes.Buffer
	cmd.Stdout, cmd.Stderr = &output, &output
	if err := launcher.Start(cmd, profile); err != nil {
		t.Fatal(err)
	}
	if err := launcher.Wait(cmd); err != nil {
		t.Fatalf("sandbox MCP=%s %v", output.String(), err)
	}
}

func TestMCPFixtureProcess(t *testing.T) {
	if os.Getenv("MERAKCODE_MCP_FIXTURE") != "1" {
		return
	}
	server := mcp.Server{Tools: tool.NewPool("fixture", tool.ReadFile{}), Env: tool.Env{Workdir: ".", Reads: new(tool.Reads)}}
	_ = server.Serve(context.Background(), os.Stdin, os.Stdout)
	os.Exit(0)
}

func TestMCPProcessEnforcesTheSessionSandboxReadDenials(t *testing.T) {
	if runtime.GOOS != "linux" {
		t.Skip("requires Landlock")
	}
	directory, private := t.TempDir(), t.TempDir()
	if err := os.WriteFile(filepath.Join(private, "secret.txt"), []byte("private fixture"), 0600); err != nil {
		t.Fatal(err)
	}
	launcher := new(sandbox.Launcher)
	profile := sandbox.Profile{WriteAllow: []string{directory}, ReadDeny: []string{private}, Network: sandbox.Network{Mode: "off"}}
	if !launcher.Status(t.Context(), profile).Available {
		t.Skip("sandbox unavailable")
	}
	defer launcher.Close()
	command, _ := os.Executable()
	process, err := mcp.Start(t.Context(), "docs", config.MCPServer{Command: command, Args: []string{"-test.run=^TestMCPFixtureProcess$"}, Env: map[string]string{"MERAKCODE_MCP_FIXTURE": "1"}}, tool.Env{Workdir: directory, Sandbox: launcher, SandboxProfile: profile})
	if err != nil {
		t.Fatal(err)
	}
	defer process.Close()
	input, _ := json.Marshal(map[string]string{"path": filepath.Join(private, "secret.txt")})
	result, err := process.Tools[0].Run(t.Context(), tool.Call{Input: input})
	if err != nil || !result.IsError {
		t.Fatalf("sandbox read denial bypassed: %+v %v", result, err)
	}
}

func TestMCPProcessUsesWorkspaceAndStopsWithItsSession(t *testing.T) {
	directory := t.TempDir()
	if err := os.WriteFile(filepath.Join(directory, "note.txt"), []byte("process fixture"), 0600); err != nil {
		t.Fatal(err)
	}
	command, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(t.Context(), 5*time.Second)
	defer cancel()
	process, err := mcp.Start(ctx, "docs", config.MCPServer{Command: command, Args: []string{"-test.run=^TestMCPFixtureProcess$"}, Env: map[string]string{"MERAKCODE_MCP_FIXTURE": "1"}}, tool.Env{Workdir: directory, Sandbox: &sandbox.Launcher{Disabled: true}})
	if err != nil {
		t.Fatal(err)
	}
	defer process.Close()
	if len(process.Tools) != 1 || process.Tools[0].Spec().Name != "mcp__docs__read_file" {
		t.Fatalf("tools=%+v", process.Tools)
	}
	result, err := process.Tools[0].Run(ctx, tool.Call{Input: json.RawMessage(`{"path":"note.txt"}`)})
	if err != nil || result.IsError {
		t.Fatalf("result=%+v err=%v", result, err)
	}
	cancel()
	if err := process.Close(); err != nil {
		t.Fatal(err)
	}
}
