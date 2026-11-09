//go:build windows && sandbox_integration

package sandbox_test

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"strings"
	"sync"
	"testing"
	"time"

	"golang.org/x/sys/windows"

	"github.com/TongTong313/merakcode/merak/internal/platform/sandbox"
)

func TestWindowsConcurrentClaimsKeepAllReadDenialCleanupPaths(t *testing.T) {
	state := os.Getenv("MERAKCODE_SANDBOX_TEST_STATE")
	var commands []*exec.Cmd
	var launchers []*sandbox.Launcher
	var profiles []sandbox.Profile
	var paths []string
	for range 2 {
		l := &sandbox.Launcher{StateDir: state}
		t.Cleanup(func() {
			if err := l.Close(); err != nil {
				t.Error(err)
			}
		})
		p := sandbox.Profile{WriteAllow: []string{t.TempDir()}, EnvAllow: []string{"SystemRoot"}}
		for range 6 {
			p.ReadDeny = append(p.ReadDeny, t.TempDir())
		}
		paths = append(paths, p.ReadDeny...)
		cmd, err := l.Command(t.Context(), p, os.Args[0], "-test.run=^TestSandboxChild$", "--", "environment", "unused")
		if err != nil {
			t.Fatal(err)
		}
		commands, launchers, profiles = append(commands, cmd), append(launchers, l), append(profiles, p)
	}
	var started sync.WaitGroup
	for i := range commands {
		started.Go(func() {
			if err := launchers[i].Start(commands[i], profiles[i]); err != nil {
				t.Error(err)
				return
			}
			if err := launchers[i].Wait(commands[i]); err != nil {
				t.Error(err)
			}
		})
	}
	started.Wait()
	body, err := os.ReadFile(filepath.Join(state, "accounts.json"))
	if err != nil {
		t.Fatal(err)
	}
	var manifest struct {
		DenyRoots []string `json:"denyRoots"`
	}
	if err := json.Unmarshal(body, &manifest); err != nil {
		t.Fatal(err)
	}
	for _, path := range paths {
		if !slices.Contains(manifest.DenyRoots, path) {
			t.Errorf("reset would leave group denial on path=%s", path)
		}
	}
}

func TestWindowsRestrictedStartupFailureRequiresApprovalBeforeFallback(t *testing.T) {
	state := os.Getenv("MERAKCODE_SANDBOX_TEST_STATE")
	if state == "" {
		t.Fatal("initialize the isolated test account pool")
	}
	for _, allowed := range []bool{false, true} {
		t.Run(map[bool]string{false: "denied", true: "approved"}[allowed], func(t *testing.T) {
			workspace := t.TempDir()
			member := filepath.Join(workspace, "member.exe")
			body, err := os.ReadFile(os.Args[0])
			if err != nil {
				t.Fatal(err)
			}
			if err := os.WriteFile(member, body, 0700); err != nil {
				t.Fatal(err)
			}
			marker := filepath.Join(workspace, "started")
			t.Setenv("MERAKCODE_SANDBOX_TEST_VALUE", "approved fallback")
			asked := 0
			launcher := &sandbox.Launcher{StateDir: state, Unavailable: func(_ context.Context, status sandbox.Status) error {
				asked++
				if status.Available || status.Reason == "" {
					t.Errorf("startup failure status=%+v", status)
				}
				if _, err := os.Stat(marker); !os.IsNotExist(err) {
					t.Errorf("member started before approval: path=%s error=%v", marker, err)
				}
				if !allowed {
					return errors.New("MRK-5006")
				}
				return nil
			}}
			defer launcher.Close()
			p := sandbox.Profile{WriteAllow: []string{workspace}, EnvAllow: []string{"SystemRoot", "MERAKCODE_SANDBOX_TEST_VALUE"}}
			ctx, cancel := context.WithTimeout(t.Context(), 25*time.Second)
			defer cancel()
			cmd, err := launcher.Command(ctx, p, member, "-test.run=^TestSandboxChild$", "--", "write-env", marker)
			if err != nil {
				t.Fatal(err)
			}
			manifest, err := os.ReadFile(filepath.Join(state, "accounts.json"))
			if err != nil {
				t.Fatal(err)
			}
			var pool struct{ Group struct{ SID string } }
			if err := json.Unmarshal(bytes.TrimPrefix(manifest, []byte{0xef, 0xbb, 0xbf}), &pool); err != nil || pool.Group.SID == "" {
				t.Fatalf("test pool identity: %v", err)
			}
			if out, err := exec.Command("icacls", member, "/deny", "*"+pool.Group.SID+":RX").CombinedOutput(); err != nil {
				t.Fatalf("deny test member execution: %v %s", err, out)
			}
			cmd.Dir = workspace
			var output bytes.Buffer
			cmd.Stdout, cmd.Stderr = &output, &output
			err = launcher.Start(cmd, p)
			if allowed {
				if err != nil {
					t.Fatalf("approved startup: %v %s", err, output.String())
				}
				if err := launcher.Wait(cmd); err != nil {
					t.Fatalf("approved member: %v %s", err, output.String())
				}
				if body, err := os.ReadFile(marker); err != nil || string(body) != "approved fallback" {
					t.Fatalf("approved output: path=%s error=%v", marker, err)
				}
			} else if err == nil || !strings.Contains(err.Error(), "MRK-5006") {
				t.Fatalf("denied startup: %v %s", err, output.String())
			}
			if asked != 1 {
				t.Errorf("startup approval count=%d, want 1", asked)
			}
		})
	}
}

func TestWindowsConfiguredAccountRunsAConfinedMember(t *testing.T) {
	state := os.Getenv("MERAKCODE_SANDBOX_TEST_STATE")
	if state == "" {
		t.Fatal("initialize the isolated test account pool and set MERAKCODE_SANDBOX_TEST_STATE")
	}
	ctx, cancel := context.WithTimeout(t.Context(), 20*time.Second)
	defer cancel()
	workspace := t.TempDir()
	launcher := &sandbox.Launcher{StateDir: state}
	t.Cleanup(func() {
		if err := launcher.Close(); err != nil {
			t.Error(err)
		}
	})
	profile := sandbox.Profile{WriteAllow: []string{workspace}, EnvAllow: []string{"SystemRoot", "MERAKCODE_SANDBOX_TEST_VALUE"}}
	t.Setenv("MERAKCODE_SANDBOX_TEST_VALUE", "account member output")
	command, err := launcher.Command(ctx, profile, os.Args[0], "-test.run=^TestSandboxChild$", "--", "write-env", filepath.Join(workspace, "inside.txt"))
	if err != nil {
		t.Fatal(err)
	}
	command.Dir = workspace
	if body, err := command.CombinedOutput(); err != nil {
		t.Fatalf("member failed: %v %s", err, body)
	}
	if body, err := os.ReadFile(filepath.Join(workspace, "inside.txt")); err != nil || string(body) != "account member output" {
		t.Fatalf("workspace output=%q error=%v", body, err)
	}
}

func TestWindowsConfiguredPoolReportsAvailableFileIsolation(t *testing.T) {
	state := os.Getenv("MERAKCODE_SANDBOX_TEST_STATE")
	if state == "" {
		t.Fatal("initialize the isolated test account pool and set MERAKCODE_SANDBOX_TEST_STATE")
	}
	launcher := &sandbox.Launcher{StateDir: state}
	status := launcher.Status(t.Context(), sandbox.Profile{WriteAllow: []string{t.TempDir()}})
	if !status.Available || status.Backend != "windows-account" {
		t.Fatalf("configured account pool status=%+v", status)
	}
	if err := launcher.Close(); err != nil {
		t.Fatal(err)
	}
}

func TestWindowsStartupFailureIsDifferentFromMemberExit125(t *testing.T) {
	state := os.Getenv("MERAKCODE_SANDBOX_TEST_STATE")
	if state == "" {
		t.Fatal("initialize the isolated test account pool and set MERAKCODE_SANDBOX_TEST_STATE")
	}
	ctx, cancel := context.WithTimeout(t.Context(), 20*time.Second)
	defer cancel()
	launcher := &sandbox.Launcher{StateDir: state}
	defer launcher.Close()
	workspace := t.TempDir()
	p := sandbox.Profile{WriteAllow: []string{workspace}, EnvAllow: []string{"SystemRoot"}}
	node, err := exec.LookPath("node")
	if err != nil {
		t.Fatal(err)
	}
	cmd, err := launcher.Command(ctx, p, node, "-e", "process.exit(125)")
	if err != nil {
		t.Fatal(err)
	}
	if err := launcher.Start(cmd, p); err != nil {
		t.Fatal(err)
	}
	var exit *exec.ExitError
	if err := launcher.Wait(cmd); !errors.As(err, &exit) || exit.ExitCode() != 125 {
		t.Fatalf("member exit=%v", err)
	}
	if status := launcher.Status(ctx, p); !status.Available {
		t.Fatalf("member exit changed sandbox status: %+v", status)
	}
	missing := filepath.Join(workspace, "removed.exe")
	body, err := os.ReadFile(os.Args[0])
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(missing, body, 0700); err != nil {
		t.Fatal(err)
	}
	cmd, err = launcher.Command(ctx, p, missing)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.Remove(missing); err != nil {
		t.Fatal(err)
	}
	if err := launcher.Start(cmd, p); err == nil {
		_ = launcher.Wait(cmd)
		t.Fatal("sandbox startup failure was reported as a started member")
	}
	if status := launcher.Status(ctx, p); status.Available || status.Reason == "" {
		t.Fatalf("failed startup status=%+v", status)
	}
}

func TestWindowsMissingBrokerReportsUnavailable(t *testing.T) {
	launcher := &sandbox.Launcher{StateDir: os.Getenv("MERAKCODE_SANDBOX_TEST_STATE")}
	defer launcher.Close()
	p := sandbox.Profile{WriteAllow: []string{t.TempDir()}, EnvAllow: []string{"SystemRoot"}}
	cmd, err := launcher.Command(t.Context(), p, os.Args[0])
	if err != nil {
		t.Fatal(err)
	}
	cmd.Path = filepath.Join(p.WriteAllow[0], "missing-broker.exe")
	if err := launcher.Start(cmd, p); err == nil {
		t.Fatal("missing broker started")
	}
	if status := launcher.Status(t.Context(), p); status.Available || status.Reason == "" {
		t.Fatalf("missing helper path=%s status=%+v", cmd.Path, status)
	}
}

func TestWindowsProtectionOverridesWorkspaceWriteAccess(t *testing.T) {
	state := os.Getenv("MERAKCODE_SANDBOX_TEST_STATE")
	if state == "" {
		t.Fatal("initialize the isolated test account pool and set MERAKCODE_SANDBOX_TEST_STATE")
	}
	workspace := t.TempDir()
	hooks := filepath.Join(workspace, "hooks")
	if err := os.Mkdir(hooks, 0700); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(hooks, "hook")
	if err := os.WriteFile(path, []byte("original"), 0600); err != nil {
		t.Fatal(err)
	}
	missing := filepath.Join(workspace, "missing.json")
	t.Setenv("MERAKCODE_SANDBOX_TEST_VALUE", "modified")
	launcher := &sandbox.Launcher{StateDir: state}
	defer launcher.Close()
	profile := sandbox.Profile{WriteAllow: []string{workspace}, Protect: []string{hooks, missing}, EnvAllow: []string{"SystemRoot", "MERAKCODE_SANDBOX_TEST_VALUE"}}
	for _, target := range []string{filepath.Join(workspace, "ordinary"), path} {
		cmd, err := launcher.Command(t.Context(), profile, os.Args[0], "-test.run=^TestSandboxChild$", "--", "write-env", target)
		if err != nil {
			t.Fatal(err)
		}
		cmd.Dir = workspace
		output, err := cmd.CombinedOutput()
		if target != path {
			if err != nil {
				t.Fatalf("ordinary write failed: %v %s", err, output)
			}
			continue
		}
		var exit *exec.ExitError
		if !errors.As(err, &exit) || exit.ExitCode() != 1 {
			t.Fatalf("protected write=%v output=%s", err, output)
		}
	}
	if body, err := os.ReadFile(path); err != nil || string(body) != "original" {
		t.Fatalf("protected contents=%q error=%v", body, err)
	}
	status := launcher.Status(t.Context(), profile)
	if len(status.Protect) != 2 || status.Protect[0].State != "enforced" || status.Protect[1].State != "missing" {
		t.Fatalf("protection status=%+v", status.Protect)
	}
	if _, err := os.Stat(missing); !os.IsNotExist(err) {
		t.Fatalf("missing path was created: %v", err)
	}
}

func TestWindowsMemberKeepsTheUsersProfileAndUsesPrivateTemp(t *testing.T) {
	state := os.Getenv("MERAKCODE_SANDBOX_TEST_STATE")
	if state == "" {
		t.Fatal("initialize the isolated test account pool and set MERAKCODE_SANDBOX_TEST_STATE")
	}
	ctx, cancel := context.WithTimeout(t.Context(), 20*time.Second)
	defer cancel()
	workspace := t.TempDir()
	names := []string{"SystemRoot", "USERPROFILE", "APPDATA", "LOCALAPPDATA", "TEMP", "TMP", "GIT_CONFIG_COUNT", "GIT_CONFIG_KEY_0", "GIT_CONFIG_VALUE_0"}
	t.Setenv("GIT_CONFIG_COUNT", "1")
	t.Setenv("GIT_CONFIG_KEY_0", "user.name")
	t.Setenv("GIT_CONFIG_VALUE_0", "Sandbox Fixture")
	launcher := &sandbox.Launcher{StateDir: state}
	t.Cleanup(func() {
		if err := launcher.Close(); err != nil {
			t.Error(err)
		}
	})
	command, err := launcher.Command(ctx, sandbox.Profile{WriteAllow: []string{workspace}, EnvAllow: names}, os.Args[0], "-test.run=^TestSandboxChild$", "--", "environment", "unused")
	if err != nil {
		t.Fatal(err)
	}
	command.Dir = workspace
	body, err := command.Output()
	if err != nil {
		t.Fatal(err)
	}
	var entries []string
	if err := json.Unmarshal(body, &entries); err != nil {
		t.Fatal(err)
	}
	values := map[string]string{}
	for _, entry := range entries {
		name, value, _ := strings.Cut(entry, "=")
		if _, exists := values[strings.ToUpper(name)]; exists {
			t.Fatal("member received duplicate environment names")
		}
		values[strings.ToUpper(name)] = value
	}
	for _, name := range []string{"USERPROFILE", "APPDATA", "LOCALAPPDATA"} {
		if values[name] != os.Getenv(name) {
			t.Errorf("%s does not preserve the user's real directory", name)
		}
	}
	if values["TEMP"] == os.Getenv("TEMP") || values["TEMP"] == "" || values["TMP"] != values["TEMP"] {
		t.Error("TEMP and TMP do not share a private directory")
	}
	for name, directory := range map[string]string{"NPM_CONFIG_CACHE": "npm", "NPM_CONFIG_STORE_DIR": "pnpm", "YARN_CACHE_FOLDER": "yarn", "PIP_CACHE_DIR": "pip", "UV_CACHE_DIR": "uv", "GOCACHE": "go-build", "GOMODCACHE": "go-mod"} {
		if values[name] != filepath.Join(values["TEMP"], directory) {
			t.Errorf("%s cache is outside private directory: path=%s private=%s", name, values[name], values["TEMP"])
		}
	}
	if values["GIT_CONFIG_COUNT"] != "2" || values["GIT_CONFIG_KEY_0"] != "user.name" || values["GIT_CONFIG_VALUE_0"] != "Sandbox Fixture" || values["GIT_CONFIG_KEY_1"] != "safe.directory" || values["GIT_CONFIG_VALUE_1"] != "*" {
		t.Error("sandbox did not append safe.directory while preserving existing Git settings")
	}
}

func TestWindowsMemberCannotReadCredentialDirectories(t *testing.T) {
	state := os.Getenv("MERAKCODE_SANDBOX_TEST_STATE")
	if state == "" {
		t.Fatal("initialize the isolated test account pool and set MERAKCODE_SANDBOX_TEST_STATE")
	}
	ctx, cancel := context.WithTimeout(t.Context(), 20*time.Second)
	defer cancel()
	workspace := t.TempDir()
	credentials := filepath.Join(workspace, ".ssh")
	if err := os.Mkdir(credentials, 0700); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(credentials, "fixture")
	if err := os.WriteFile(path, []byte("private fixture"), 0600); err != nil {
		t.Fatal(err)
	}
	launcher := &sandbox.Launcher{StateDir: state}
	t.Cleanup(func() {
		if err := launcher.Close(); err != nil {
			t.Error(err)
		}
	})
	command, err := launcher.Command(ctx, sandbox.Profile{WriteAllow: []string{workspace}, ReadDeny: []string{credentials}, EnvAllow: []string{"SystemRoot"}}, os.Args[0], "-test.run=^TestSandboxChild$", "--", "read", path)
	if err != nil {
		t.Fatal(err)
	}
	command.Dir = workspace
	body, err := command.CombinedOutput()
	if err == nil || strings.Contains(string(body), "private fixture") {
		t.Fatalf("member read the credential fixture: error=%v", err)
	}
	if body, err := os.ReadFile(path); err != nil || string(body) != "private fixture" {
		t.Fatalf("credential owner lost access: error=%v", err)
	}
}

func TestWindowsProductReadDenialEndsWhenTheAccountReturns(t *testing.T) {
	state := os.Getenv("MERAKCODE_SANDBOX_TEST_STATE")
	if state == "" {
		t.Fatal("initialize the isolated test account pool and set MERAKCODE_SANDBOX_TEST_STATE")
	}
	ctx, cancel := context.WithTimeout(t.Context(), 20*time.Second)
	defer cancel()
	workspace := t.TempDir()
	product := filepath.Join(workspace, "product-state")
	if err := os.Mkdir(product, 0700); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(product, "fixture")
	if err := os.WriteFile(path, []byte("product fixture"), 0600); err != nil {
		t.Fatal(err)
	}
	launcher := &sandbox.Launcher{StateDir: state}
	t.Cleanup(func() {
		if err := launcher.Close(); err != nil {
			t.Error(err)
		}
	})
	for index, denied := range []bool{true, true, false} {
		if index == 2 {
			if err := launcher.Close(); err != nil {
				t.Fatal(err)
			}
			launcher = &sandbox.Launcher{StateDir: state}
		}
		profile := sandbox.Profile{WriteAllow: []string{workspace}, EnvAllow: []string{"SystemRoot"}}
		if index == 0 {
			profile.ReadDeny, profile.TransientReadDeny = []string{product}, []string{product}
		}
		command, err := launcher.Command(ctx, profile, os.Args[0], "-test.run=^TestSandboxChild$", "--", "read", path)
		if err != nil {
			t.Fatal(err)
		}
		command.Dir = workspace
		body, err := command.CombinedOutput()
		if denied && (err == nil || strings.Contains(string(body), "product fixture")) {
			t.Fatal("member read another product's state")
		}
		if !denied && (err != nil || !strings.Contains(string(body), "product fixture")) {
			t.Fatalf("own product state remained denied after account return: %v %s", err, body)
		}
	}
}

func TestWindowsPrivateTempExcludesEngineReadDenial(t *testing.T) {
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
	t.Cleanup(func() {
		if err := launcher.Close(); err != nil {
			t.Error(err)
		}
	})
	const script = `const fs=require('node:fs'), path=require('node:path');
fs.writeFileSync(path.join(process.env.TEMP,'fixture'),'private temp');
let denied=false;try{fs.readFileSync(process.argv[1]);}catch(error){denied=error.code==='EACCES'||error.code==='EPERM';}
if(!denied) process.exit(23);
process.stdout.write('private temp accessible; engine data denied');`
	command, err := launcher.Command(ctx, sandbox.Profile{WriteAllow: []string{workspace}, ReadDeny: []string{state}, EnvAllow: []string{"SystemRoot"}}, node, "-e", script, filepath.Join(state, "accounts.json"))
	if err != nil {
		t.Fatal(err)
	}
	command.Dir = workspace
	if body, err := command.CombinedOutput(); err != nil || string(body) != "private temp accessible; engine data denied" {
		t.Fatalf("private directory result: %v %s", err, body)
	}
}

func TestWindowsPrivateTempDoesNotInheritParentPermissions(t *testing.T) {
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
	t.Cleanup(func() {
		if err := launcher.Close(); err != nil {
			t.Error(err)
		}
	})
	command, err := launcher.Command(ctx, sandbox.Profile{WriteAllow: []string{workspace}, EnvAllow: []string{"SystemRoot"}}, node, "-e", `process.stdout.write(process.env.TEMP+'\n');process.stdin.resume();`)
	if err != nil {
		t.Fatal(err)
	}
	command.Dir = workspace
	stdin, err := command.StdinPipe()
	if err != nil {
		t.Fatal(err)
	}
	stdout, err := command.StdoutPipe()
	if err != nil {
		t.Fatal(err)
	}
	if err := command.Start(); err != nil {
		t.Fatal(err)
	}
	defer func() { stdin.Close(); command.Wait() }()
	line, err := bufio.NewReader(stdout).ReadString('\n')
	if err != nil {
		t.Fatal(err)
	}
	descriptor, err := windows.GetNamedSecurityInfo(strings.TrimSpace(line), windows.SE_FILE_OBJECT, windows.DACL_SECURITY_INFORMATION)
	if err != nil {
		t.Fatal(err)
	}
	control, _, err := descriptor.Control()
	if err != nil || control&windows.SE_DACL_PROTECTED == 0 {
		t.Fatalf("private directory still inherits parent permissions: error=%v", err)
	}
}

func TestWindowsAccountRestrictsWorkspaceAndDriveRootWrites(t *testing.T) {
	state := os.Getenv("MERAKCODE_SANDBOX_TEST_STATE")
	if state == "" {
		t.Fatal("initialize the isolated test account pool and set MERAKCODE_SANDBOX_TEST_STATE")
	}
	root := t.TempDir()
	workspace := filepath.Join(root, "workspace")
	if err := os.Mkdir(workspace, 0700); err != nil {
		t.Fatal(err)
	}
	drive := filepath.VolumeName(root) + string(filepath.Separator)
	outside, err := os.MkdirTemp(drive, "merak-sbx-test-")
	if err != nil {
		t.Fatal(err)
	}
	if filepath.Dir(outside) != drive || !strings.HasPrefix(filepath.Base(outside), "merak-sbx-test-") {
		t.Fatal("invalid drive-root fixture directory")
	}
	t.Cleanup(func() {
		if err := os.RemoveAll(outside); err != nil {
			t.Error(err)
		}
	})
	for _, test := range []struct {
		name, path string
		allowed    bool
	}{
		{"workspace", filepath.Join(workspace, "inside.txt"), true},
		{"outside workspace", filepath.Join(root, "outside.txt"), false},
		{"drive-root directory", filepath.Join(outside, "outside.txt"), false},
	} {
		t.Run(test.name, func(t *testing.T) {
			ctx, cancel := context.WithTimeout(t.Context(), 20*time.Second)
			defer cancel()
			launcher := &sandbox.Launcher{StateDir: state}
			t.Cleanup(func() {
				if err := launcher.Close(); err != nil {
					t.Error(err)
				}
			})
			command, err := launcher.Command(ctx, sandbox.Profile{WriteAllow: []string{workspace}, EnvAllow: []string{"SystemRoot"}}, os.Args[0], "-test.run=^TestSandboxChild$", "--", "write-env", test.path)
			if err != nil {
				t.Fatal(err)
			}
			command.Dir = workspace
			body, runErr := command.CombinedOutput()
			_, readErr := os.Stat(test.path)
			if test.allowed && (runErr != nil || readErr != nil) {
				t.Fatalf("allowed write failed: %v %v %s", runErr, readErr, body)
			}
			if !test.allowed && (runErr == nil || !os.IsNotExist(readErr)) {
				t.Fatalf("outside write succeeded: %v %v %s", runErr, readErr, body)
			}
		})
	}
}
