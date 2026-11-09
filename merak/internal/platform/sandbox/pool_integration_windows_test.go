//go:build windows && sandbox_integration

package sandbox_test

import (
	"bufio"
	"context"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/TongTong313/merakcode/merak/internal/platform/process"
	"github.com/TongTong313/merakcode/merak/internal/platform/sandbox"
)

func TestWindowsThirdClaimWaitsForAnAccount(t *testing.T) {
	state := os.Getenv("MERAKCODE_SANDBOX_TEST_STATE")
	if state == "" {
		t.Fatal("initialize the isolated test account pool and set MERAKCODE_SANDBOX_TEST_STATE")
	}
	node, err := exec.LookPath("node")
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(t.Context(), 20*time.Second)
	defer cancel()
	type member struct {
		command  *exec.Cmd
		input    io.WriteCloser
		output   *bufio.Reader
		launcher *sandbox.Launcher
	}
	start := func(workspace string, launcher *sandbox.Launcher) (member, error) {
		command, err := launcher.Command(ctx, sandbox.Profile{WriteAllow: []string{workspace}, EnvAllow: []string{"SystemRoot"}}, node, "-e", `process.stdout.write('ready\n');process.stdin.resume();`)
		if err != nil {
			return member{}, err
		}
		command.Dir = workspace
		input, err := command.StdinPipe()
		if err != nil {
			return member{}, err
		}
		output, err := command.StdoutPipe()
		if err != nil {
			input.Close()
			return member{}, err
		}
		if err := command.Start(); err != nil {
			input.Close()
			output.Close()
			return member{}, err
		}
		return member{command: command, input: input, output: bufio.NewReader(output), launcher: launcher}, nil
	}
	closeMember := func(child member) {
		child.input.Close()
		if err := child.command.Wait(); err != nil {
			t.Error(err)
		}
		if err := child.launcher.Close(); err != nil {
			t.Error(err)
		}
	}
	var active []member
	defer func() {
		for _, child := range active {
			closeMember(child)
		}
	}()
	for range 2 {
		launcher := &sandbox.Launcher{StateDir: state}
		child, err := start(t.TempDir(), launcher)
		if err != nil {
			t.Fatal(err)
		}
		active = append(active, child)
		line, err := child.output.ReadString('\n')
		if err != nil || strings.TrimSpace(line) != "ready" {
			t.Fatalf("member readiness: %q %v", line, err)
		}
	}
	third := &sandbox.Launcher{StateDir: state}
	workspace := t.TempDir()
	type result struct {
		member member
		err    error
	}
	started := make(chan result, 1)
	go func() { child, err := start(workspace, third); started <- result{child, err} }()
	select {
	case result := <-started:
		if result.err == nil {
			active = append(active, result.member)
		}
		t.Fatalf("third claim did not wait: %v", result.err)
	case <-time.After(150 * time.Millisecond):
	}
	closeMember(active[0])
	active = active[1:]
	select {
	case result := <-started:
		if result.err != nil {
			t.Fatal(result.err)
		}
		active = append(active, result.member)
		line, err := result.member.output.ReadString('\n')
		if err != nil || strings.TrimSpace(line) != "ready" {
			t.Fatalf("queued member readiness: %q %v", line, err)
		}
	case <-ctx.Done():
		t.Fatal("third claim did not acquire the returned account")
	}
}

func TestWindowsConcurrentClaimsCannotWriteEachOthersWorkspace(t *testing.T) {
	state := os.Getenv("MERAKCODE_SANDBOX_TEST_STATE")
	if state == "" {
		t.Fatal("initialize the isolated test account pool and set MERAKCODE_SANDBOX_TEST_STATE")
	}
	node, err := exec.LookPath("node")
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(t.Context(), 20*time.Second)
	defer cancel()
	type member struct {
		workspace string
		command   *exec.Cmd
		input     io.WriteCloser
		output    *bufio.Reader
		launcher  *sandbox.Launcher
	}
	var active []member
	defer func() {
		for _, child := range active {
			child.input.Close()
			if err := child.command.Wait(); err != nil {
				t.Error(err)
			}
			if err := child.launcher.Close(); err != nil {
				t.Error(err)
			}
		}
	}()
	const script = `const fs=require('node:fs');fs.writeFileSync('inside.txt','own claim');process.stdout.write('ready\n');
require('node:readline').createInterface({input:process.stdin}).on('line',path=>{
try{fs.writeFileSync(path,'cross claim');process.stdout.write('wrote\n');}
catch(error){process.stdout.write(error.code+'\n');}
});`
	for range 2 {
		workspace := t.TempDir()
		launcher := &sandbox.Launcher{StateDir: state}
		command, err := launcher.Command(ctx, sandbox.Profile{WriteAllow: []string{workspace}, EnvAllow: []string{"SystemRoot"}}, node, "-e", script)
		if err != nil {
			t.Fatal(err)
		}
		command.Dir = workspace
		input, err := command.StdinPipe()
		if err != nil {
			t.Fatal(err)
		}
		output, err := command.StdoutPipe()
		if err != nil {
			input.Close()
			t.Fatal(err)
		}
		if err := command.Start(); err != nil {
			input.Close()
			output.Close()
			t.Fatal(err)
		}
		child := member{workspace, command, input, bufio.NewReader(output), launcher}
		active = append(active, child)
		line, err := child.output.ReadString('\n')
		if err != nil || strings.TrimSpace(line) != "ready" {
			t.Fatalf("member readiness: %q %v", line, err)
		}
	}
	for i, child := range active {
		other := active[1-i]
		for _, name := range []string{"inside.txt", "new.txt"} {
			if _, err := io.WriteString(child.input, filepath.Join(other.workspace, name)+"\n"); err != nil {
				t.Fatal(err)
			}
			line, err := child.output.ReadString('\n')
			if err != nil || strings.TrimSpace(line) != "EACCES" && strings.TrimSpace(line) != "EPERM" {
				t.Fatalf("cross-claim result=%q error=%v", line, err)
			}
		}
		body, err := os.ReadFile(filepath.Join(child.workspace, "inside.txt"))
		if err != nil || string(body) != "own claim" {
			t.Fatalf("workspace was changed: %q %v", body, err)
		}
		if _, err := os.Stat(filepath.Join(child.workspace, "new.txt")); !os.IsNotExist(err) {
			t.Fatalf("cross-claim file exists: %v", err)
		}
	}
}

func TestWindowsClaimKeepsWriteAccessWhileAnotherMemberRuns(t *testing.T) {
	state := os.Getenv("MERAKCODE_SANDBOX_TEST_STATE")
	if state == "" {
		t.Fatal("initialize the isolated test account pool and set MERAKCODE_SANDBOX_TEST_STATE")
	}
	node, err := exec.LookPath("node")
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(t.Context(), 20*time.Second)
	defer cancel()
	workspace := t.TempDir()
	launcher := &sandbox.Launcher{StateDir: state}
	defer launcher.Close()
	profile := sandbox.Profile{WriteAllow: []string{workspace}, EnvAllow: []string{"SystemRoot"}}
	first, err := launcher.Command(ctx, profile, node, "-e", `process.stdout.write('ready\n');require('node:readline').createInterface({input:process.stdin}).once('line',()=>{require('node:fs').writeFileSync('after.txt','still allowed');process.exit(0);});`)
	if err != nil {
		t.Fatal(err)
	}
	first.Dir = workspace
	input, err := first.StdinPipe()
	if err != nil {
		t.Fatal(err)
	}
	output, err := first.StdoutPipe()
	if err != nil {
		input.Close()
		t.Fatal(err)
	}
	if err := first.Start(); err != nil {
		input.Close()
		output.Close()
		t.Fatal(err)
	}
	defer func() { input.Close(); first.Wait() }()
	line, err := bufio.NewReader(output).ReadString('\n')
	if err != nil || strings.TrimSpace(line) != "ready" {
		t.Fatalf("member readiness: %q %v", line, err)
	}
	second, err := launcher.Command(ctx, profile, os.Args[0], "-test.run=^TestSandboxChild$", "--", "write-env", filepath.Join(workspace, "second.txt"))
	if err != nil {
		t.Fatal(err)
	}
	second.Dir = workspace
	if body, err := second.CombinedOutput(); err != nil {
		t.Fatalf("second member: %v %s", err, body)
	}
	if _, err := io.WriteString(input, "continue\n"); err != nil {
		t.Fatal(err)
	}
	if err := first.Wait(); err != nil {
		t.Fatalf("first member lost access when second exited: %v", err)
	}
	if body, err := os.ReadFile(filepath.Join(workspace, "after.txt")); err != nil || string(body) != "still allowed" {
		t.Fatalf("remaining member output=%q error=%v", body, err)
	}
}

func TestWindowsAccountReuseRemovesACrashedClaimsWriteAccess(t *testing.T) {
	state := os.Getenv("MERAKCODE_SANDBOX_TEST_STATE")
	if state == "" {
		t.Fatal("initialize the isolated test account pool and set MERAKCODE_SANDBOX_TEST_STATE")
	}
	ctx, cancel := context.WithTimeout(t.Context(), 20*time.Second)
	defer cancel()
	previous := t.TempDir()
	owner := process.Command(ctx, "", os.Args[0], "-test.run=^TestWindowsLeaseOwnerFixture$", "--", state, previous)
	output, err := owner.StdoutPipe()
	if err != nil {
		t.Fatal(err)
	}
	if err := owner.Start(); err != nil {
		t.Fatal(err)
	}
	defer func() { owner.Process.Kill(); owner.Wait() }()
	line, err := bufio.NewReader(output).ReadString('\n')
	if err != nil || strings.TrimSpace(line) != "leased" {
		t.Fatalf("lease owner readiness=%q error=%v", line, err)
	}
	if err := owner.Process.Kill(); err != nil {
		t.Fatal(err)
	}
	owner.Wait()
	launcher := &sandbox.Launcher{StateDir: state}
	defer launcher.Close()
	workspace := t.TempDir()
	path := filepath.Join(previous, "after-crash.txt")
	command, err := launcher.Command(ctx, sandbox.Profile{WriteAllow: []string{workspace}, EnvAllow: []string{"SystemRoot"}}, os.Args[0], "-test.run=^TestSandboxChild$", "--", "write-env", path)
	if err != nil {
		t.Fatal(err)
	}
	command.Dir = workspace
	if body, err := command.CombinedOutput(); err == nil {
		t.Fatalf("reused account retained the crashed claim's write access: %s", body)
	}
	if _, err := os.Stat(path); !os.IsNotExist(err) {
		t.Fatalf("crashed claim workspace was writable: %v", err)
	}
}

func TestWindowsLeaseOwnerFixture(t *testing.T) {
	for i, arg := range os.Args {
		if arg != "--" || len(os.Args) < i+3 {
			continue
		}
		launcher := &sandbox.Launcher{StateDir: os.Args[i+1]}
		if _, err := launcher.Command(t.Context(), sandbox.Profile{WriteAllow: []string{os.Args[i+2]}}, os.Args[0]); err != nil {
			t.Fatal(err)
		}
		os.Stdout.WriteString("leased\n")
		for {
			time.Sleep(time.Hour)
		}
	}
}
