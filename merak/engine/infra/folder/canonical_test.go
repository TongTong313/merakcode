package folder_test

import (
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"testing"

	"github.com/TongTong313/merakcode/merak/engine/infra/folder"
)

func TestEverySpellingOfADirectoryHasOneCanonicalForm(t *testing.T) {
	dir := t.TempDir()
	want, err := folder.Canonical(dir)
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
		got, err := folder.Canonical(spelling)
		if err != nil || got != want {
			t.Errorf("Canonical(%q) = %q, %v; want %q", spelling, got, err, want)
		}
		if !folder.SameDirectory(spelling, dir) {
			t.Errorf("%q and %q are the same directory", spelling, dir)
		}
	}
	if strings.HasSuffix(want, string(filepath.Separator)) {
		t.Errorf("the canonical form %q ends with a separator", want)
	}
	other := t.TempDir()
	if folder.SameDirectory(other, dir) {
		t.Error("two different directories are the same")
	}
}

func TestACanonicalFormFollowsLinksAndDoesNotNeedTheDirectoryToExist(t *testing.T) {
	dir := t.TempDir()
	link := filepath.Join(t.TempDir(), "link")
	if err := os.Symlink(dir, link); err != nil {
		t.Skipf("no symbolic links here: %v", err)
	}
	if !folder.SameDirectory(link, dir) {
		t.Error("a link and its target are one directory")
	}
	missing := filepath.Join(dir, "missing") + string(filepath.Separator)
	got, err := folder.Canonical(missing)
	if err != nil || strings.HasSuffix(got, string(filepath.Separator)) {
		t.Errorf("a missing directory canonicalizes to %q, %v", got, err)
	}
	if _, err := folder.Canonical("  "); err == nil {
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
	if !folder.SameDirectory(flipped, dir) || !folder.SameDirectory(strings.ToUpper(dir), strings.ToLower(dir)) {
		t.Errorf("%q and %q are the same directory", flipped, dir)
	}
	a, _ := folder.Canonical(flipped)
	b, _ := folder.Canonical(dir)
	if a != b {
		t.Errorf("%q != %q", a, b)
	}
}

func TestOnWindowsAJunctionAndItsTargetAreOneDirectory(t *testing.T) {
	if runtime.GOOS != "windows" {
		t.Skip("windows only")
	}
	dir := t.TempDir()
	junction := filepath.Join(t.TempDir(), "junction")
	if out, err := exec.Command("cmd", "/c", "mklink", "/J", junction, dir).CombinedOutput(); err != nil {
		t.Skipf("no junctions here: %v %s", err, out)
	}
	got, err := folder.Canonical(junction)
	want, _ := folder.Canonical(dir)
	if err != nil || got != want {
		t.Errorf("Canonical(junction) = %q, %v; want %q", got, err, want)
	}
	if !folder.SameDirectory(junction, dir) {
		t.Error("a junction and its target are one directory")
	}
}

func TestOnWindowsASubstDriveKeepsItsLetterBecauseItMayGoOffline(t *testing.T) {
	if runtime.GOOS != "windows" {
		t.Skip("windows only")
	}
	dir := t.TempDir()
	if err := os.Mkdir(filepath.Join(dir, "old"), 0o755); err != nil {
		t.Fatal(err)
	}
	var drive string
	for _, letter := range "YZXWV" {
		candidate := string(letter) + ":"
		if _, err := os.Stat(candidate + `\`); err != nil {
			drive = candidate
			break
		}
	}
	if drive == "" {
		t.Skip("no free drive letter")
	}
	if out, err := exec.Command("subst.exe", drive, dir).CombinedOutput(); err != nil {
		t.Skipf("no subst here: %v %s", err, out)
	}
	defer func() { _ = exec.Command("subst.exe", drive, "/D").Run() }()
	got, err := folder.Canonical(drive + `\old`)
	if err != nil || got != drive+`\old` {
		t.Errorf("Canonical of a folder on %s = %q, %v; the drive letter must stay", drive, got, err)
	}
}
