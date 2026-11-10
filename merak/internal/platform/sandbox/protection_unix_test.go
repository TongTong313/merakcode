//go:build !windows

package sandbox_test

import (
	"errors"
	"os"
	"path/filepath"
	"testing"

	"github.com/TongTong313/merakcode/merak/internal/platform/process"
	"github.com/TongTong313/merakcode/merak/internal/platform/sandbox"
)

func TestProtectionRestoresContentsAfterDirectoryPermissionsAreRemoved(t *testing.T) {
	if os.Geteuid() == 0 {
		t.Skip("requires a user without permission bypass")
	}
	directory := filepath.Join(t.TempDir(), "hooks")
	if err := os.Mkdir(directory, 0700); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		_ = os.Chmod(directory, 0700)
		_ = os.Chmod(filepath.Join(directory, "added"), 0700)
	})
	path := filepath.Join(directory, "pre-commit")
	if err := os.WriteFile(path, []byte("original"), 0600); err != nil {
		t.Fatal(err)
	}
	launcher := new(sandbox.Launcher)
	defer launcher.Close()
	cmd := process.Command(t.Context(), "", os.Args[0], "-test.run=^TestProtectionPermissionChild$", "--", directory)
	if err := launcher.Start(cmd, sandbox.Profile{Protect: []string{directory}}); err != nil {
		t.Fatal(err)
	}
	var changed *sandbox.ProtectionError
	if err := launcher.Wait(cmd); !errors.As(err, &changed) || changed.Err != nil {
		t.Fatalf("rollback error=%v; want a protection change with successful restoration", err)
	}
	if body, err := os.ReadFile(path); err != nil || string(body) != "original" {
		t.Fatalf("protected contents=%q error=%v", body, err)
	}
	if _, err := os.Stat(filepath.Join(directory, "added")); !os.IsNotExist(err) {
		t.Fatalf("unreadable addition survived rollback: %v", err)
	}
	if info, err := os.Stat(directory); err != nil || info.Mode().Perm() != 0700 {
		t.Fatalf("directory permissions were not restored: %v", err)
	}
}

func TestProtectionPermissionChild(t *testing.T) {
	for i, arg := range os.Args {
		if arg != "--" || len(os.Args) != i+2 {
			continue
		}
		directory := os.Args[i+1]
		if err := os.WriteFile(filepath.Join(directory, "pre-commit"), []byte("modified"), 0000); err != nil {
			t.Fatal(err)
		}
		added := filepath.Join(directory, "added")
		if err := os.Mkdir(added, 0700); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(added, "file"), []byte("added"), 0000); err != nil {
			t.Fatal(err)
		}
		if err := os.Chmod(added, 0000); err != nil {
			t.Fatal(err)
		}
		if err := os.Chmod(directory, 0000); err != nil {
			t.Fatal(err)
		}
		os.Exit(0)
	}
}
