//go:build windows && sandbox_integration

package sandbox_test

import (
	"bufio"
	"context"
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"golang.org/x/sys/windows"

	"github.com/TongTong313/merakcode/merak/internal/platform/sandbox"
)

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
	for _, denied := range []bool{true, false} {
		profile := sandbox.Profile{WriteAllow: []string{workspace}, EnvAllow: []string{"SystemRoot"}}
		if denied {
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
