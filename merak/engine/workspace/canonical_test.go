package workspace_test

import (
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"

	"github.com/TongTong313/merakcode/merak/engine/workspace"
)

func TestEverySpellingOfADirectoryHasOneCanonicalForm(t *testing.T) {
	dir := t.TempDir()
	want, err := workspace.Canonical(dir)
	if err != nil {
		t.Fatal(err)
	}
	spellings := []string{
		dir + string(filepath.Separator),
		filepath.ToSlash(dir),
		filepath.ToSlash(dir) + "/",
		filepath.Join(dir, "sub", ".."),
		filepath.Join(dir, ".") + string(filepath.Separator) + string(filepath.Separator),
	}
	if err := os.Mkdir(filepath.Join(dir, "sub"), 0o755); err != nil {
		t.Fatal(err)
	}
	for _, spelling := range spellings {
		got, err := workspace.Canonical(spelling)
		if err != nil || got != want {
			t.Errorf("Canonical(%q) = %q, %v; want %q", spelling, got, err, want)
		}
		if !workspace.SameDirectory(spelling, dir) {
			t.Errorf("%q and %q are the same directory", spelling, dir)
		}
	}
	if strings.HasSuffix(want, string(filepath.Separator)) {
		t.Errorf("the canonical form %q ends with a separator", want)
	}
	other := t.TempDir()
	if workspace.SameDirectory(other, dir) {
		t.Error("two different directories are the same")
	}
}

func TestACanonicalFormFollowsLinksAndDoesNotNeedTheDirectoryToExist(t *testing.T) {
	dir := t.TempDir()
	link := filepath.Join(t.TempDir(), "link")
	if err := os.Symlink(dir, link); err != nil {
		t.Skipf("no symbolic links here: %v", err)
	}
	if !workspace.SameDirectory(link, dir) {
		t.Error("a link and its target are one directory")
	}
	missing := filepath.Join(dir, "missing") + string(filepath.Separator)
	got, err := workspace.Canonical(missing)
	if err != nil || strings.HasSuffix(got, string(filepath.Separator)) {
		t.Errorf("a missing directory canonicalizes to %q, %v", got, err)
	}
	if _, err := workspace.Canonical("  "); err == nil {
		t.Error("an empty directory has no canonical form")
	}
}

func TestOnWindowsDriveLettersAndCaseDoNotMakeADifferentDirectory(t *testing.T) {
	if runtime.GOOS != "windows" {
		t.Skip("windows only")
	}
	dir := t.TempDir()
	flipped := strings.ToUpper(dir[:1]) + dir[1:]
	if dir[0] >= 'A' && dir[0] <= 'Z' {
		flipped = strings.ToLower(dir[:1]) + dir[1:]
	}
	if !workspace.SameDirectory(flipped, dir) || !workspace.SameDirectory(strings.ToUpper(dir), strings.ToLower(dir)) {
		t.Errorf("%q and %q are the same directory", flipped, dir)
	}
	a, _ := workspace.Canonical(flipped)
	b, _ := workspace.Canonical(dir)
	if a != b {
		t.Errorf("%q != %q", a, b)
	}
}
