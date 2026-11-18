// Package enginetest provides dependencies for engine scenario tests.
package enginetest

import (
	"os"
	"path/filepath"
	"testing"

	"github.com/TongTong313/merakcode/merak/engine"
	"github.com/TongTong313/merakcode/merak/storage/memory"
	"github.com/TongTong313/merakcode/merak/storage/vault"
)

// Deps gives each test its own storage, credential vault and data directory.
func Deps(t testing.TB) engine.Deps {
	t.Helper()
	data := t.TempDir()
	return engine.Deps{
		Store:   memory.New(),
		Vault:   vault.NewMemory(),
		DataDir: data,
		Dirs:    Dirs(t, data),
	}
}

// Dirs preserves the existing paths when a test supplies its own data directory.
func Dirs(t testing.TB, data string) engine.Dirs {
	t.Helper()
	if data != "" {
		return engine.Dirs{
			Snapshots:    filepath.Join(data, "snapshots"),
			Worktrees:    data,
			SkillCache:   filepath.Join(data, "..", "cache", "skills"),
			SandboxState: filepath.Join(data, "sandbox"),
			Temporary:    os.TempDir(),
		}
	}
	return engine.Dirs{
		Snapshots:    t.TempDir(),
		Worktrees:    filepath.Join(os.TempDir(), "merak-chat"),
		SkillCache:   filepath.Join(os.TempDir(), "merak-skills"),
		SandboxState: os.TempDir(),
		Temporary:    os.TempDir(),
	}
}
