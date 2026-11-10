package sandbox_test

import (
	"bufio"
	"context"
	"errors"
	"io"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/TongTong313/merakcode/merak/internal/platform/process"
	"github.com/TongTong313/merakcode/merak/internal/platform/sandbox"
)

func TestConcurrentProtectionRestoresTheOriginalContents(t *testing.T) {
	path := filepath.Join(t.TempDir(), "merakcode.json")
	if err := os.WriteFile(path, []byte("original"), 0600); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(t.Context(), 10*time.Second)
	defer cancel()
	start := func(content string) func() {
		t.Helper()
		launcher := new(sandbox.Launcher)
		t.Cleanup(func() { _ = launcher.Close() })
		cmd := process.Command(ctx, "", os.Args[0], "-test.run=^TestProtectionChild$", "--", path, content)
		input, err := cmd.StdinPipe()
		if err != nil {
			t.Fatal(err)
		}
		output, err := cmd.StdoutPipe()
		if err != nil {
			t.Fatal(err)
		}
		if err := launcher.Start(cmd, sandbox.Profile{Protect: []string{path}}); err != nil {
			t.Fatal(err)
		}
		if line, err := bufio.NewReader(output).ReadString('\n'); err != nil || line != "ready\n" {
			t.Fatalf("child readiness=%q error=%v", line, err)
		}
		return func() {
			t.Helper()
			_ = input.Close()
			err := launcher.Wait(cmd)
			var changed *sandbox.ProtectionError
			if err != nil && !errors.As(err, &changed) {
				t.Fatal(err)
			}
		}
	}
	first := start("modified by first")
	second := start("modified by second")
	first()
	second()
	if body, err := os.ReadFile(path); err != nil || string(body) != "original" {
		t.Fatalf("protected contents=%q error=%v; want original", body, err)
	}
}

func TestProtectionChild(t *testing.T) {
	for i, arg := range os.Args {
		if arg != "--" || len(os.Args) != i+3 {
			continue
		}
		if err := os.WriteFile(os.Args[i+1], []byte(os.Args[i+2]), 0600); err != nil {
			t.Fatal(err)
		}
		if _, err := io.WriteString(os.Stdout, "ready\n"); err != nil {
			t.Fatal(err)
		}
		_, _ = io.Copy(io.Discard, os.Stdin)
		os.Exit(0)
	}
}
