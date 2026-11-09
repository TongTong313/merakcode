package sandbox_test

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"strings"
	"sync/atomic"
	"syscall"
	"testing"
	"time"

	"golang.org/x/sys/unix"

	"github.com/TongTong313/merakcode/merak/internal/platform/sandbox"
)

func TestLinuxSandboxUsesAndRemovesPrivateTemporaryFiles(t *testing.T) {
	state := t.TempDir()
	launcher := &sandbox.Launcher{StateDir: state}
	defer launcher.Close()
	p := sandbox.Profile{ReadDeny: []string{state}}
	cmd, err := launcher.Command(t.Context(), p, os.Args[0], "-test.run=^TestSandboxChild$", "--", "temporary-file", "unused")
	if err != nil {
		t.Fatal(err)
	}
	var output bytes.Buffer
	cmd.Stdout, cmd.Stderr = &output, &output
	if err := launcher.Start(cmd, p); err != nil {
		t.Fatal(err)
	}
	if err := launcher.Wait(cmd); err != nil {
		t.Fatalf("temporary write=%q error=%v", output.String(), err)
	}
	path := output.String()
	if !strings.HasPrefix(path, state+string(filepath.Separator)) {
		t.Fatalf("temporary file is outside private state: %q", path)
	}
	if _, err := os.Stat(filepath.Dir(path)); !os.IsNotExist(err) {
		t.Fatalf("private directory remained after exit: %v", err)
	}
}

func TestLinuxSandboxConfinesWritesToAllowedDirectory(t *testing.T) {
	root := t.TempDir()
	workspace := filepath.Join(root, "workspace")
	if err := os.Mkdir(workspace, 0o700); err != nil {
		t.Fatal(err)
	}
	t.Setenv("MERAKCODE_SANDBOX_TEST_VALUE", "allowed content")
	profile := sandbox.Profile{WriteAllow: []string{workspace}, EnvAllow: []string{"MERAKCODE_SANDBOX_TEST_VALUE"}}
	launcher := new(sandbox.Launcher)
	for _, test := range []struct {
		name    string
		path    string
		allowed bool
	}{
		{"allows workspace writes", filepath.Join(workspace, "inside.txt"), true},
		{"denies writes outside the workspace", filepath.Join(root, "outside.txt"), false},
	} {
		t.Run(test.name, func(t *testing.T) {
			cmd, err := launcher.Command(context.Background(), profile, os.Args[0], "-test.run=^TestSandboxChild$", "--", "write-env", test.path)
			if err != nil {
				t.Fatal(err)
			}
			output, err := cmd.CombinedOutput()
			if test.allowed {
				if err != nil {
					t.Fatalf("allowed command failed: %v: %s", err, output)
				}
				data, err := os.ReadFile(test.path)
				if err != nil || string(data) != "allowed content" {
					t.Fatalf("workspace output = %q, error %v", data, err)
				}
				return
			}
			if err == nil {
				t.Fatal("sandbox allowed a write outside the workspace")
			}
			if _, err := os.Stat(test.path); !os.IsNotExist(err) {
				t.Fatalf("outside file exists or cannot be inspected: %v", err)
			}
		})
	}
}

func TestLinuxSandboxDeniesCredentialReadsAndAllowsOrdinaryReads(t *testing.T) {
	root := t.TempDir()
	credentials := filepath.Join(root, ".ssh")
	if err := os.Mkdir(credentials, 0o700); err != nil {
		t.Fatal(err)
	}
	launcher := new(sandbox.Launcher)
	profile := sandbox.Profile{ReadDeny: []string{credentials}, WriteAllow: []string{root}}
	for _, test := range []struct {
		name    string
		path    string
		allowed bool
	}{
		{"allows ordinary reads", filepath.Join(root, "source.txt"), true},
		{"denies credential reads", filepath.Join(credentials, "key"), false},
	} {
		t.Run(test.name, func(t *testing.T) {
			if err := os.WriteFile(test.path, []byte("fixture content"), 0o600); err != nil {
				t.Fatal(err)
			}
			cmd, err := launcher.Command(context.Background(), profile, os.Args[0], "-test.run=^TestSandboxChild$", "--", "read", test.path)
			if err != nil {
				t.Fatal(err)
			}
			output, err := cmd.CombinedOutput()
			if test.allowed {
				if err != nil || string(output) != "fixture content" {
					t.Fatalf("ordinary read = %q, %v", output, err)
				}
				return
			}
			if err == nil {
				t.Fatal("sandbox allowed reading a credential")
			}
		})
	}
}

func TestLinuxSandboxReportsProtectionWithoutDisablingLandlock(t *testing.T) {
	root := t.TempDir()
	existing := filepath.Join(root, "merakcode.json")
	missing := filepath.Join(root, "merakcode.jsonc")
	if err := os.WriteFile(existing, []byte("{}"), 0o600); err != nil {
		t.Fatal(err)
	}
	launcher := new(sandbox.Launcher)
	status := launcher.Status(context.Background(), sandbox.Profile{WriteAllow: []string{root}, Protect: []string{existing, missing}})
	if !status.Available || status.Backend != "landlock" {
		t.Fatalf("Landlock unavailable: %+v", status)
	}
	if len(status.Protect) != 2 || status.Protect[0].Path != existing || status.Protect[0].State != "unenforced" || status.Protect[1].Path != missing || status.Protect[1].State != "missing" {
		t.Fatalf("protection status = %+v", status.Protect)
	}
	if _, err := os.Stat(missing); !os.IsNotExist(err) {
		t.Fatalf("Status created the missing protected path: %v", err)
	}
}

func TestLinuxSandboxEnforcesOrReportsUnavailableNetworkRestrictions(t *testing.T) {
	expectedNetwork := linuxNetworkCapability(t)
	var requests atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requests.Add(1)
		io.WriteString(w, "reachable")
	}))
	defer server.Close()
	response, err := http.Get(server.URL)
	if err != nil {
		t.Fatal(err)
	}
	response.Body.Close()
	launcher := new(sandbox.Launcher)
	status := launcher.Status(context.Background(), sandbox.Profile{})
	if !status.Available || status.Network != expectedNetwork {
		t.Fatalf("network capability = %+v, expected %s", status, expectedNetwork)
	}
	var limits []string
	if expectedNetwork == "ports" {
		limits = []string{"port-only", "udp-open"}
	}
	if !slices.Equal(status.Limits, limits) {
		t.Fatalf("network limits = %v, expected %v", status.Limits, limits)
	}
	cmd, err := launcher.Command(context.Background(), sandbox.Profile{Network: sandbox.Network{Mode: "off"}}, os.Args[0], "-test.run=^TestSandboxChild$", "--", "fetch", server.URL)
	if err != nil {
		t.Fatal(err)
	}
	output, err := cmd.CombinedOutput()
	if expectedNetwork == "none" {
		if err != nil || string(output) != "reachable" || requests.Load() != 2 {
			t.Fatalf("unenforced network returned %q, error %v, requests %d", output, err, requests.Load())
		}
		return
	}
	if err == nil || requests.Load() != 1 {
		t.Fatalf("network off returned %q, error %v, requests %d", output, err, requests.Load())
	}
}

func TestLinuxSandboxUsesAvailableUserAndNetworkNamespaces(t *testing.T) {
	expectedNetwork := linuxNetworkCapability(t)
	namespacesAvailable := expectedNetwork == "namespace"
	for _, mode := range []string{"off", "allowlist", "on"} {
		t.Run(mode, func(t *testing.T) {
			launcher := new(sandbox.Launcher)
			profile := sandbox.Profile{Network: sandbox.Network{Mode: mode}}
			status := launcher.Status(context.Background(), profile)
			if !status.Available || status.Network != expectedNetwork {
				t.Fatalf("namespace-capable system reported %+v", status)
			}
			cmd, err := launcher.Command(context.Background(), profile, os.Args[0], "-test.run=^TestSandboxChild$", "--", "namespaces", "unused")
			if err != nil {
				t.Fatal(err)
			}
			output, err := cmd.CombinedOutput()
			if err != nil {
				t.Fatalf("namespace command: %v: %s", err, output)
			}
			var child map[string]string
			if err := json.Unmarshal(output, &child); err != nil {
				t.Fatal(err)
			}
			for _, name := range []string{"user", "net"} {
				parent, err := os.Readlink("/proc/self/ns/" + name)
				if err != nil || child[name] == "" || (child[name] != parent) != namespacesAvailable {
					t.Fatalf("%s namespace: parent=%q child=%q error=%v", name, parent, child[name], err)
				}
			}
		})
	}
}

func TestLinuxSandboxProxyAllowsOnlyApprovedDestinations(t *testing.T) {
	expectedNetwork := linuxNetworkCapability(t)
	var requests atomic.Int32
	handler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requests.Add(1)
		io.WriteString(w, "approved response")
	})
	allowed := httptest.NewServer(handler)
	defer allowed.Close()
	denied := httptest.NewServer(handler)
	defer denied.Close()
	profile := sandbox.Profile{Network: sandbox.Network{Mode: "allowlist", LocalPorts: []int{allowed.Listener.Addr().(*net.TCPAddr).Port}}}
	launcher := new(sandbox.Launcher)
	for _, test := range []struct {
		name      string
		operation string
		url       string
		allowed   bool
	}{
		{"allows an approved proxy destination", "fetch-proxy", allowed.URL, true},
		{"denies an unapproved proxy destination", "fetch-proxy", denied.URL, false},
		{"direct access matches reported enforcement", "fetch", allowed.URL, expectedNetwork == "none"},
	} {
		t.Run(test.name, func(t *testing.T) {
			cmd, err := launcher.Command(context.Background(), profile, os.Args[0], "-test.run=^TestSandboxChild$", "--", test.operation, test.url)
			if err != nil {
				t.Fatal(err)
			}
			output, err := cmd.CombinedOutput()
			if test.allowed {
				if err != nil || string(output) != "approved response" {
					t.Fatalf("approved request = %q, %v", output, err)
				}
				return
			}
			if err == nil || requests.Load() != 1 {
				t.Fatalf("unapproved request = %q, %v; target requests %d", output, err, requests.Load())
			}
		})
	}
}

func TestLinuxSandboxUnknownHostReachesTheEngineApproval(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	asked := make(chan string, 1)
	launcher := &sandbox.Launcher{ApproveNetwork: func(_ context.Context, host string) (bool, error) {
		asked <- host
		return false, nil
	}}
	cmd, err := launcher.Command(ctx, sandbox.Profile{Network: sandbox.Network{Mode: "allowlist"}}, os.Args[0], "-test.run=^TestSandboxChild$", "--", "fetch-proxy", "http://unknown.example.com/")
	if err != nil {
		t.Fatal(err)
	}
	output, err := cmd.CombinedOutput()
	if err == nil {
		t.Fatalf("unapproved request succeeded: %s", output)
	}
	select {
	case host := <-asked:
		if host != "unknown.example.com" {
			t.Fatalf("approval host = %q", host)
		}
	default:
		t.Fatalf("sandbox never asked the engine to approve the host: %s", output)
	}
}

// The operating system is the oracle, independent of the launcher's status report.
func linuxNetworkCapability(t *testing.T) string {
	t.Helper()
	probe := exec.Command(os.Args[0], "-test.run=^TestSandboxChild$", "--", "namespaces", "unused")
	probe.SysProcAttr = &syscall.SysProcAttr{
		Cloneflags:                 syscall.CLONE_NEWUSER | syscall.CLONE_NEWNET,
		UidMappings:                []syscall.SysProcIDMap{{ContainerID: 0, HostID: os.Getuid(), Size: 1}},
		GidMappings:                []syscall.SysProcIDMap{{ContainerID: 0, HostID: os.Getgid(), Size: 1}},
		GidMappingsEnableSetgroups: false,
	}
	if probe.Run() == nil {
		return "namespace"
	}
	abi, _, errno := unix.Syscall(unix.SYS_LANDLOCK_CREATE_RULESET, 0, 0, unix.LANDLOCK_CREATE_RULESET_VERSION)
	if errno != 0 {
		t.Fatalf("Landlock kernel probe failed: %v", errno)
	}
	if abi >= 4 {
		return "ports"
	}
	return "none"
}

func TestLinuxSandboxCancellationLeavesNoProxyFiles(t *testing.T) {
	root := t.TempDir()
	t.Setenv("TMPDIR", root)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	launcher := new(sandbox.Launcher)
	profile := sandbox.Profile{EnvAllow: []string{"TMPDIR"}, Network: sandbox.Network{Mode: "allowlist"}}
	cmd, err := launcher.Command(ctx, profile, os.Args[0], "-test.run=^TestSandboxChild$", "--", "wait", "unused")
	if err != nil {
		t.Fatal(err)
	}
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		t.Fatal(err)
	}
	if err := launcher.Start(cmd, profile); err != nil {
		t.Fatal(err)
	}
	ready, readErr := bufio.NewReader(stdout).ReadString('\n')
	cancel()
	waitErr := launcher.Wait(cmd)
	if readErr != nil || ready != "ready\n" || waitErr == nil {
		t.Fatalf("child ready=%q read error=%v wait error=%v", ready, readErr, waitErr)
	}
	entries, err := os.ReadDir(root)
	if err != nil || len(entries) != 0 {
		t.Fatalf("cancellation left %d proxy paths: %v", len(entries), err)
	}
}

func TestLinuxSandboxEnforcesEnvironmentWhitelistAtExecution(t *testing.T) {
	t.Setenv("MERAKCODE_ALLOWED_VALUE", "allowed")
	launcher := new(sandbox.Launcher)
	profile := sandbox.Profile{EnvAllow: []string{"MERAKCODE_ALLOWED_VALUE"}}
	cmd, err := launcher.Command(context.Background(), profile, os.Args[0], "-test.run=^TestSandboxChild$", "--", "environment", "unused")
	if err != nil {
		t.Fatal(err)
	}
	cmd.Env = append(cmd.Env, "MERAKCODE_UNAPPROVED_VALUE=fixture")
	output, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("environment command failed: %v", err)
	}
	var received []string
	if err := json.Unmarshal(output, &received); err != nil {
		t.Fatal(err)
	}
	want := map[string]bool{"MERAKCODE_ALLOWED_VALUE": true, "TEMP": true, "TMP": true, "TMPDIR": true, "npm_config_cache": true, "npm_config_store_dir": true, "YARN_CACHE_FOLDER": true, "PIP_CACHE_DIR": true, "UV_CACHE_DIR": true, "GOCACHE": true, "GOMODCACHE": true}
	for _, entry := range received {
		name, value, _ := strings.Cut(entry, "=")
		if !want[name] || value == "" {
			t.Fatal("child received an unapproved or empty environment entry")
		}
		if name == "MERAKCODE_ALLOWED_VALUE" && value != "allowed" {
			t.Fatal("allowed environment value changed")
		}
		delete(want, name)
	}
	if len(want) != 0 {
		t.Fatalf("missing approved environment variables: %v", want)
	}
}
