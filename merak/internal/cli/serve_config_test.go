package cli

import (
	"fmt"
	"net"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"testing"
	"time"

	"github.com/TongTong313/merakcode/merak/internal/server"
)

func freePort(t *testing.T) int {
	t.Helper()
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer listener.Close()
	return listener.Addr().(*net.TCPAddr).Port
}

func TestServeListensOnThePortOfTheConfigurationFile(t *testing.T) {
	home := t.TempDir()
	t.Setenv("MERAKCODE_HOME", home)
	port := freePort(t)
	file := fmt.Sprintf(`{"server":{"port":%d,"hostname":"127.0.0.1","mdns":true}}`, port)
	if err := os.WriteFile(filepath.Join(home, "merakcode.json"), []byte(file), 0600); err != nil {
		t.Fatal(err)
	}
	executable, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	child := exec.Command(executable, "serve")
	prepareBackground(child)
	if err := child.Start(); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = child.Process.Kill(); _, _ = child.Process.Wait() })
	deadline := time.Now().Add(8 * time.Second)
	for {
		info, err := server.ReadInfo(filepath.Join(home, "data"))
		if err == nil {
			parsed, _ := url.Parse(info.Endpoint)
			if parsed.Port() != fmt.Sprint(port) {
				t.Fatalf("endpoint=%s, want port %d", info.Endpoint, port)
			}
			return
		}
		if time.Now().After(deadline) {
			t.Fatal("serve did not start")
		}
		time.Sleep(20 * time.Millisecond)
	}
}

func TestServeNoLongerKnowsTheRemoteStoreMode(t *testing.T) {
	t.Setenv("MERAKCODE_HOME", t.TempDir())
	ctx := t.Context()
	if code := serve(ctx, []string{"--store", "remote"}); code != 2 {
		t.Fatalf("serve --store remote = %d, want 2", code)
	}
}
