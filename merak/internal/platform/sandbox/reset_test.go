package sandbox_test

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/TongTong313/merakcode/merak/internal/platform/sandbox"
)

func TestInitializedFollowsTheAccountManifest(t *testing.T) {
	directory := t.TempDir()
	if sandbox.Initialized(directory) {
		t.Fatal("an empty state folder counts as initialized")
	}
	if sandbox.Initialized(filepath.Join(directory, "missing")) {
		t.Fatal("a missing state folder counts as initialized")
	}
	if err := os.WriteFile(filepath.Join(directory, "accounts.json"), []byte("{}"), 0o600); err != nil {
		t.Fatal(err)
	}
	if !sandbox.Initialized(directory) {
		t.Fatal("a folder with an account manifest does not count as initialized")
	}
}

func TestResetOfAFolderWithoutAccountsChangesNothing(t *testing.T) {
	directory := t.TempDir()
	if err := sandbox.Reset(context.Background(), directory); err != nil {
		t.Fatalf("reset=%v", err)
	}
	entries, err := os.ReadDir(directory)
	if err != nil || len(entries) != 0 {
		t.Fatalf("entries=%v err=%v", entries, err)
	}
	missing := filepath.Join(directory, "never-created")
	if err := sandbox.Reset(context.Background(), missing); err != nil {
		t.Fatalf("reset of a missing folder=%v", err)
	}
	if _, err := os.Stat(missing); !os.IsNotExist(err) {
		t.Fatalf("reset created %s", missing)
	}
}

func TestResetRejectsFoldersThatCouldNeverHoldAPool(t *testing.T) {
	root := filepath.VolumeName(t.TempDir()) + string(filepath.Separator)
	for name, directory := range map[string]string{"empty": "", "relative": "state", "drive root": root} {
		t.Run(name, func(t *testing.T) {
			err := sandbox.Reset(context.Background(), directory)
			if err == nil || !strings.Contains(err.Error(), "MRK-5013") {
				t.Fatalf("error=%v", err)
			}
		})
	}
}

func TestCancelledResetDoesNotStartAnything(t *testing.T) {
	ctx, cancel := context.WithCancel(t.Context())
	cancel()
	if err := sandbox.Reset(ctx, t.TempDir()); !errors.Is(err, context.Canceled) {
		t.Fatalf("error=%v", err)
	}
}

func TestTheResetScriptsAreEmbeddedBesideTheSetupScripts(t *testing.T) {
	for _, name := range []string{"reset-windows.ps1", "access-windows.ps1", "setup-windows.ps1", "credential-windows.ps1"} {
		body, err := os.ReadFile(filepath.Join("scripts", name))
		if err != nil || len(body) == 0 {
			t.Errorf("scripts/%s: %v", name, err)
		}
	}
}
