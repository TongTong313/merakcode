package sandbox_test

import (
	"context"
	"encoding/json"
	"os"
	"strings"
	"testing"

	"github.com/TongTong313/merakcode/merak/internal/platform/sandbox"
)

func TestWindowsSandboxReportsMissingSetup(t *testing.T) {
	dir := t.TempDir()
	launcher := &sandbox.Launcher{StateDir: dir}
	status := launcher.Status(context.Background(), sandbox.Profile{})
	if status.Available || status.Backend != "windows-account" || status.Reason != "MRK-5004" {
		t.Fatalf("unconfigured account status = %+v", status)
	}
	entries, err := os.ReadDir(dir)
	if err != nil || len(entries) != 0 {
		t.Fatalf("status changed the setup directory: %d entries, %v", len(entries), err)
	}
}

func TestWindowsUnavailableSandboxStillFiltersInheritedEnvironment(t *testing.T) {
	t.Setenv("MERAKCODE_ALLOWED_FIXTURE", "visible")
	t.Setenv("MERAKCODE_PRIVATE_FIXTURE", "must-not-reach-child")
	launcher := &sandbox.Launcher{StateDir: t.TempDir(), Unavailable: func(context.Context, sandbox.Status) error { return nil }}
	cmd, err := launcher.Command(t.Context(), sandbox.Profile{EnvAllow: []string{"SystemRoot", "MERAKCODE_ALLOWED_FIXTURE"}}, os.Args[0], "-test.run=^TestSandboxChild$", "--", "environment", "unused")
	if err != nil {
		t.Fatal(err)
	}
	body, err := cmd.Output()
	if err != nil {
		t.Fatal(err)
	}
	var environment []string
	if err := json.Unmarshal(body, &environment); err != nil {
		t.Fatal(err)
	}
	seen := false
	for _, entry := range environment {
		name, _, _ := strings.Cut(entry, "=")
		if strings.EqualFold(name, "SystemRoot") {
			continue
		}
		if entry == "MERAKCODE_ALLOWED_FIXTURE=visible" {
			seen = true
			continue
		}
		t.Fatal("unrestricted startup inherited an environment variable outside the whitelist")
	}
	if !seen {
		t.Error("explicitly allowed environment variable was removed")
	}
}
