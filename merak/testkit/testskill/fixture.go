// Package testskill prepares files shared by skill tests.
package testskill

import (
	"os"
	"path/filepath"
	"testing"
)

// Put writes one file of a skill fixture beneath its root.
func Put(t *testing.T, root, name, body string) {
	t.Helper()
	path := filepath.Join(root, filepath.FromSlash(name))
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(body), 0o644); err != nil {
		t.Fatal(err)
	}
}
