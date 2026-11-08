package cli

import (
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/TongTong313/merakcode/merak/internal/server"
)

func TestStopExitsTheServeProcessAndRemovesConnectionFile(t *testing.T) {
	home := t.TempDir()
	t.Setenv("MERAKCODE_HOME", home)
	executable, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	child := exec.Command(executable, "serve")
	prepareBackground(child)
	if err := child.Start(); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = child.Process.Kill() })
	done := make(chan error, 1)
	go func() { done <- child.Wait() }()
	deadline := time.Now().Add(5 * time.Second)
	for {
		if _, err := server.ReadInfo(home); err == nil {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("serve did not start")
		}
		time.Sleep(10 * time.Millisecond)
	}
	if code := Run([]string{"stop"}, strings.NewReader(""), io.Discard); code != 0 {
		t.Fatalf("stop=%d", code)
	}
	select {
	case err := <-done:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(10 * time.Second):
		t.Fatal("serve did not stop")
	}
	if _, err := os.Stat(filepath.Join(home, "engine.json")); !os.IsNotExist(err) {
		t.Fatalf("connection file remains: %v", err)
	}
}
