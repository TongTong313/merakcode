package cli

import (
	"path/filepath"
	"testing"
)

func TestEveryFileLivesUnderOneRoot(t *testing.T) {
	root := t.TempDir()
	t.Setenv("MERAKCODE_HOME", root)
	if got, err := configRoot(); err != nil || got != root {
		t.Fatalf("config root = %q, %v", got, err)
	}
	if got, err := dataHome(); err != nil || got != filepath.Join(root, "data") {
		t.Fatalf("data directory = %q, %v", got, err)
	}
}

func TestTheRootIsTheDotMerakcodeFolderOfTheUserWhenNothingMovesIt(t *testing.T) {
	user := t.TempDir()
	t.Setenv("MERAKCODE_HOME", "")
	t.Setenv("HOME", user)
	t.Setenv("USERPROFILE", user)
	if got, err := configRoot(); err != nil || got != filepath.Join(user, ".merakcode") {
		t.Fatalf("config root = %q, %v", got, err)
	}
	if got, err := dataHome(); err != nil || got != filepath.Join(user, ".merakcode", "data") {
		t.Fatalf("data directory = %q, %v", got, err)
	}
}
