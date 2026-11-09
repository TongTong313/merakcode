//go:build sandbox_integration

package sandbox_test

import (
	"bytes"
	"errors"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"testing"

	"github.com/TongTong313/merakcode/merak/internal/platform/sandbox"
)

func consistencyLauncher(t *testing.T) *sandbox.Launcher {
	t.Helper()
	l := &sandbox.Launcher{StateDir: os.Getenv("MERAKCODE_SANDBOX_TEST_STATE")}
	t.Cleanup(func() {
		if err := l.Close(); err != nil {
			t.Error(err)
		}
	})
	if status := l.Status(t.Context(), sandbox.Profile{}); !status.Available {
		t.Fatalf("required kernel sandbox unavailable: %+v", status)
	}
	return l
}

func consistencyCommand(t *testing.T, l *sandbox.Launcher, p sandbox.Profile, directory, binary string, args ...string) (string, error) {
	t.Helper()
	cmd, err := l.Command(t.Context(), p, binary, args...)
	if err != nil {
		return "", err
	}
	cmd.Dir = directory
	var output bytes.Buffer
	cmd.Stdout, cmd.Stderr = &output, &output
	if err := l.Start(cmd, p); err != nil {
		return output.String(), err
	}
	err = l.Wait(cmd)
	return output.String(), err
}

func TestSandboxConsistencyFiles(t *testing.T) {
	l := consistencyLauncher(t)
	root, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	prepareConsistencyHome(t, root)
	workspace, credentials := filepath.Join(root, "workspace"), filepath.Join(root, ".ssh")
	hooks := filepath.Join(workspace, ".git", "hooks")
	for _, directory := range []string{workspace, credentials, hooks} {
		if err := os.MkdirAll(directory, 0700); err != nil {
			t.Fatal(err)
		}
	}
	protected, secret, ordinary := filepath.Join(hooks, "pre-commit"), filepath.Join(credentials, "key"), filepath.Join(root, "ordinary")
	for _, path := range []string{protected, secret, ordinary} {
		if err := os.WriteFile(path, []byte("original"), 0600); err != nil {
			t.Fatal(err)
		}
	}
	missing := filepath.Join(workspace, "merakcode.json")
	p := sandbox.Profile{WriteAllow: []string{workspace}, ReadDeny: []string{credentials}, Protect: []string{hooks, missing}, EnvAllow: []string{"SystemRoot", "MERAKCODE_SANDBOX_TEST_VALUE"}}
	t.Setenv("MERAKCODE_SANDBOX_TEST_VALUE", "modified")
	status := l.Status(t.Context(), p)
	wantProtection := "enforced"
	if runtime.GOOS == "linux" {
		wantProtection = "unenforced"
	}
	if len(status.Protect) != 2 || status.Protect[0].State != wantProtection || status.Protect[1].State != "missing" {
		t.Fatalf("protection: existing=%s missing=%s status=%+v", hooks, missing, status)
	}
	if _, err := os.Stat(missing); !os.IsNotExist(err) {
		t.Fatalf("missing protection was created: path=%s error=%v", missing, err)
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
			out, err := consistencyCommand(t, l, p, workspace, os.Args[0], "-test.run=^TestSandboxChild$", "--", test.operation, test.path)
			if (err == nil) != test.allowed {
				t.Fatalf("operation=%s path=%s allowed=%t error=%v output=%s", test.operation, test.path, test.allowed, err, out)
			}
			if !test.allowed && !strings.Contains(out+err.Error(), test.path) {
				t.Errorf("denial omitted target path=%s error=%v output=%s", test.path, err, out)
			}
			if !test.allowed {
				code := "MRK-5009"
				if test.name == "protected write" && runtime.GOOS == "linux" {
					code = "MRK-5007"
				}
				if !strings.Contains(err.Error(), code) {
					t.Errorf("unclassified sandbox denial: path=%s error=%v want=%s", test.path, err, code)
				}
			}
		})
	}
	if body, err := os.ReadFile(protected); err != nil || string(body) != "original" {
		t.Fatalf("protected contents changed: path=%s error=%v", protected, err)
	}
}

func TestSandboxConsistencyNetwork(t *testing.T) {
	l := consistencyLauncher(t)
	allowed := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { _, _ = w.Write([]byte("allowed")) }))
	defer allowed.Close()
	unlisted := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { _, _ = w.Write([]byte("unlisted")) }))
	defer unlisted.Close()
	p := sandbox.Profile{EnvAllow: []string{"SystemRoot"}, Network: sandbox.Network{Mode: "allowlist", LocalPorts: []int{allowed.Listener.Addr().(*net.TCPAddr).Port}}}
	status := l.Status(t.Context(), p)
	for _, test := range []struct {
		name, operation, target string
		allowed                 bool
	}{
		{"allowed proxy destination", "fetch-proxy", allowed.URL, true},
		{"unlisted proxy destination", "fetch-proxy", unlisted.URL, false},
		{"unlisted direct destination", "fetch", unlisted.URL, status.Network == "account" || status.Network == "none"},
	} {
		t.Run(test.name, func(t *testing.T) {
			out, err := consistencyCommand(t, l, p, "", os.Args[0], "-test.run=^TestSandboxChild$", "--", test.operation, test.target)
			if (err == nil) != test.allowed {
				t.Fatalf("target=%s mechanism=%s allowed=%t error=%v output=%s", test.target, status.Network, test.allowed, err, out)
			}
		})
	}
	p.Network.Mode = "off"
	p.Network.LocalPorts = nil
	if out, err := consistencyCommand(t, l, p, "", os.Args[0], "-test.run=^TestSandboxChild$", "--", "fetch-proxy", allowed.URL); err == nil {
		t.Fatalf("network off allowed target=%s output=%s", allowed.URL, out)
	}
}

func TestSandboxConsistencyDailyTools(t *testing.T) {
	l := consistencyLauncher(t)
	workspace, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	home, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	t.Setenv("HOME", home)
	t.Setenv("USERPROFILE", home)
	prepareConsistencyHome(t, home)
	if err := os.WriteFile(filepath.Join(home, ".gitconfig"), []byte("[user]\nname = Sandbox Fixture\nemail = sandbox@example.invalid\n"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(workspace, "file"), []byte("fixture"), 0600); err != nil {
		t.Fatal(err)
	}
	p := sandbox.Profile{WriteAllow: []string{workspace}, EnvAllow: []string{"SystemRoot", "PATH", "HOME", "USERPROFILE", "APPDATA", "LOCALAPPDATA"}}
	for _, test := range []struct {
		name, binary string
		args         []string
		contains     string
		exit         int
	}{
		{"git version", "git", []string{"--version"}, "git version", 0},
		{"git init", "git", []string{"init", "--initial-branch=main"}, "", 0},
		{"git status", "git", []string{"status", "--porcelain"}, "?? file", 0},
		{"git add", "git", []string{"add", "file"}, "", 0},
		{"global identity commit", "git", []string{"commit", "-m", "fixture"}, "fixture", 0},
		{"global identity read", "git", []string{"log", "-1", "--format=%an <%ae>"}, "Sandbox Fixture <sandbox@example.invalid>", 0},
		{"node output", "node", []string{"-e", `process.stdout.write('node fixture')`}, "node fixture", 0},
		{"node private temp", "node", []string{"-e", `require('node:fs').writeFileSync(require('node:path').join(process.env.TEMP,'node-fixture'),'temporary');process.stdout.write('temporary written')`}, "temporary written", 0},
		{"arguments and UTF8", "node", []string{"-e", `process.stdout.write(JSON.stringify(process.argv.slice(1)))`, "two words", "\u4e2d\u6587", `a"b`}, "[\"two words\",\"\u4e2d\u6587\",\"a\\\"b\"]", 0},
		{"exit code", "node", []string{"-e", "process.exit(37)"}, "", 37},
	} {
		t.Run(test.name, func(t *testing.T) {
			out, err := consistencyCommand(t, l, p, workspace, test.binary, test.args...)
			code := 0
			var exit *exec.ExitError
			if errors.As(err, &exit) {
				code = exit.ExitCode()
			} else if err != nil {
				t.Fatalf("command=%s args=%q workspace=%s error=%v output=%s", test.binary, test.args, workspace, err, out)
			}
			if code != test.exit || !strings.Contains(out, test.contains) {
				t.Fatalf("command=%s args=%q workspace=%s exit=%d want=%d output=%s want=%s", test.binary, test.args, workspace, code, test.exit, out, test.contains)
			}
		})
	}
}
