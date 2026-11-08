package sandbox_test

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"

	"github.com/TongTong313/merakcode/merak/internal/platform/process"
	"github.com/TongTong313/merakcode/merak/internal/platform/sandbox"
)

func TestEnvironmentWhitelistReachesTheRealChild(t *testing.T) {
	profile := sandbox.Profile{EnvAllow: []string{"SystemRoot", "MERAKCODE_TEST_ALLOWED"}}
	cmd := process.Command(context.Background(), t.TempDir(), os.Args[0], "-test.run=^TestSandboxChild$", "--", "environment", "unused")
	cmd.Env = profile.Environment([]string{
		"SystemRoot=" + os.Getenv("SystemRoot"),
		"MERAKCODE_TEST_ALLOWED=old",
		"MERAKCODE_TEST_SECRET=not-for-child",
		"MERAKCODE_TEST_ALLOWED=visible",
		"MERAKCODE_TEST_ALLOWED_SUFFIX=not-for-child",
	})
	output, err := cmd.Output()
	if err != nil {
		t.Fatal(err)
	}
	var environment []string
	if err := json.Unmarshal(output, &environment); err != nil {
		t.Fatal(err)
	}
	want := map[string]bool{"SystemRoot=" + os.Getenv("SystemRoot"): true, "MERAKCODE_TEST_ALLOWED=visible": true}
	if len(environment) != len(want) {
		t.Fatalf("environment contains %d entries, want %d", len(environment), len(want))
	}
	for _, entry := range environment {
		if !want[entry] {
			t.Fatal("child received an unapproved environment entry")
		}
	}
}

func TestTakeoverRunsWithoutFileOrEnvironmentRestrictions(t *testing.T) {
	root := t.TempDir()
	t.Setenv("MERAKCODE_SANDBOX_TEST_VALUE", "visible")
	launcher := &sandbox.Launcher{Disabled: true}
	path := filepath.Join(root, "outside.txt")
	cmd, err := launcher.Command(context.Background(), sandbox.Profile{}, os.Args[0], "-test.run=^TestSandboxChild$", "--", "write-env", path)
	if err != nil {
		t.Fatal(err)
	}
	if output, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("command: %v: %s", err, output)
	}
	data, err := os.ReadFile(path)
	if err != nil || string(data) != "visible" {
		t.Fatalf("takeover output = %q, %v", data, err)
	}
}

func TestSandboxChild(t *testing.T) {
	for i, arg := range os.Args {
		if arg != "--" || len(os.Args) < i+3 {
			continue
		}
		var err error
		switch os.Args[i+1] {
		case "write-env":
			err = os.WriteFile(os.Args[i+2], []byte(os.Getenv("MERAKCODE_SANDBOX_TEST_VALUE")), 0o600)
		case "environment":
			err = json.NewEncoder(os.Stdout).Encode(os.Environ())
		default:
			t.Fatal("unknown child operation")
		}
		if err != nil {
			t.Fatal(err)
		}
		os.Exit(0)
	}
}
