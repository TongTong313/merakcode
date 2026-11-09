package sandbox_test

import (
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"

	"github.com/TongTong313/merakcode/merak/internal/platform/sandbox"
)

func TestDarwinSandboxConfinesFilesAndReportsProtection(t *testing.T) {
	root, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	workspace, credentials := filepath.Join(root, "workspace"), filepath.Join(root, ".ssh")
	for _, dir := range []string{workspace, credentials, filepath.Join(workspace, ".git", "hooks")} {
		if err := os.MkdirAll(dir, 0700); err != nil {
			t.Fatal(err)
		}
	}
	protected := filepath.Join(workspace, ".git", "hooks", "pre-commit")
	secret, ordinary := filepath.Join(credentials, "key"), filepath.Join(root, "ordinary")
	for _, path := range []string{protected, secret, ordinary} {
		if err := os.WriteFile(path, []byte("original"), 0600); err != nil {
			t.Fatal(err)
		}
	}
	missing := filepath.Join(workspace, "merakcode.json")
	p := sandbox.Profile{WriteAllow: []string{workspace}, ReadDeny: []string{credentials}, Protect: []string{filepath.Dir(protected), missing}}
	launcher := new(sandbox.Launcher)
	defer launcher.Close()
	status := launcher.Status(t.Context(), p)
	if !status.Available || status.Backend != "seatbelt" || status.Network != "seatbelt" || len(status.Limits) != 0 {
		t.Fatalf("sandbox status=%+v", status)
	}
	if len(status.Protect) != 2 || status.Protect[0].State != "enforced" || status.Protect[1].State != "missing" {
		t.Fatalf("protection=%+v", status.Protect)
	}
	if _, err := os.Stat(missing); !os.IsNotExist(err) {
		t.Fatalf("missing path was created: %v", err)
	}
	for _, test := range []struct {
		name, operation, path string
		allowed               bool
	}{
		{"workspace write", "write-env", filepath.Join(workspace, "source"), true},
		{"outside write", "write-env", filepath.Join(root, "outside"), false},
		{"credential read", "read", secret, false},
		{"ordinary read", "read", ordinary, true},
		{"protected write", "write-env", protected, false},
	} {
		t.Run(test.name, func(t *testing.T) {
			cmd, err := launcher.Command(t.Context(), p, os.Args[0], "-test.run=^TestSandboxChild$", "--", test.operation, test.path)
			if err != nil {
				t.Fatal(err)
			}
			out, err := cmd.CombinedOutput()
			if (err == nil) != test.allowed {
				t.Fatalf("allowed=%v output=%q error=%v", test.allowed, out, err)
			}
		})
	}
	if body, err := os.ReadFile(protected); err != nil || string(body) != "original" {
		t.Fatalf("protected file=%q error=%v", body, err)
	}
}

func TestDarwinSandboxRoutesNetworkThroughTheProxy(t *testing.T) {
	target := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { _, _ = w.Write([]byte("allowed")) }))
	defer target.Close()
	unlisted := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { _, _ = w.Write([]byte("unlisted")) }))
	defer unlisted.Close()
	launcher := new(sandbox.Launcher)
	defer launcher.Close()
	p := sandbox.Profile{Network: sandbox.Network{Mode: "allowlist", LocalPorts: []int{target.Listener.Addr().(*net.TCPAddr).Port}}}
	for _, test := range []struct {
		name, operation, target string
		allowed                 bool
	}{
		{"allowed proxy destination", "fetch-proxy", target.URL, true},
		{"unlisted proxy destination", "fetch-proxy", unlisted.URL, false},
		{"unlisted direct destination", "fetch", unlisted.URL, false},
	} {
		t.Run(test.name, func(t *testing.T) {
			cmd, err := launcher.Command(t.Context(), p, os.Args[0], "-test.run=^TestSandboxChild$", "--", test.operation, test.target)
			if err != nil {
				t.Fatal(err)
			}
			out, err := cmd.CombinedOutput()
			if (err == nil) != test.allowed {
				t.Fatalf("allowed=%v output=%q error=%v", test.allowed, out, err)
			}
		})
	}
}
