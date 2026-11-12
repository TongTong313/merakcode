package snapshot_test

import (
	"os"
	"path/filepath"
	"testing"

	"github.com/TongTong313/merakcode/merak/engine/snapshot"
)

func write(t *testing.T, dir, name, body string) {
	t.Helper()
	path := filepath.Join(dir, filepath.FromSlash(name))
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(body), 0o644); err != nil {
		t.Fatal(err)
	}
}

func read(dir, name string) (string, bool) {
	body, err := os.ReadFile(filepath.Join(dir, filepath.FromSlash(name)))
	return string(body), err == nil
}

func TestRestoreBringsBackEditedAndDeletedFilesAndRemovesNewOnes(t *testing.T) {
	work := t.TempDir()
	repo := snapshot.Repo{GitDir: filepath.Join(t.TempDir(), "shadow"), Workdir: work}
	write(t, work, "keep.txt", "one")
	write(t, work, "dir/gone.txt", "will vanish")
	write(t, work, ".gitignore", "ignored.log\n")
	write(t, work, "ignored.log", "stays")
	before, err := repo.Track(t.Context())
	if err != nil {
		t.Fatal(err)
	}

	write(t, work, "keep.txt", "two")
	write(t, work, "new/made.txt", "fresh")
	write(t, work, "ignored.log", "changed but ignored")
	if err := os.Remove(filepath.Join(work, "dir", "gone.txt")); err != nil {
		t.Fatal(err)
	}
	after, err := repo.Track(t.Context())
	if err != nil || after == before {
		t.Fatalf("after=%q before=%q err=%v", after, before, err)
	}

	if err := repo.Restore(t.Context(), before); err != nil {
		t.Fatal(err)
	}
	if body, _ := read(work, "keep.txt"); body != "one" {
		t.Fatalf("keep.txt = %q", body)
	}
	if body, ok := read(work, "dir/gone.txt"); !ok || body != "will vanish" {
		t.Fatalf("the deleted file did not come back: %q %v", body, ok)
	}
	if _, ok := read(work, "new/made.txt"); ok {
		t.Fatal("a file made after the snapshot survived")
	}
	if _, err := os.Stat(filepath.Join(work, "new")); err == nil {
		t.Fatal("the emptied directory survived")
	}
	if body, _ := read(work, "ignored.log"); body != "changed but ignored" {
		t.Fatalf("an ignored file was touched: %q", body)
	}

	if err := repo.Restore(t.Context(), after); err != nil {
		t.Fatal(err)
	}
	if body, _ := read(work, "keep.txt"); body != "two" {
		t.Fatalf("redo keep.txt = %q", body)
	}
	if body, ok := read(work, "new/made.txt"); !ok || body != "fresh" {
		t.Fatalf("redo lost the new file: %q %v", body, ok)
	}
	if _, ok := read(work, "dir/gone.txt"); ok {
		t.Fatal("redo kept the deleted file")
	}
}

func TestTheShadowRepositoryNeverTouchesTheProjectsOwnGit(t *testing.T) {
	work := t.TempDir()
	write(t, work, "a.txt", "x")
	repo := snapshot.Repo{GitDir: filepath.Join(t.TempDir(), "shadow"), Workdir: work}
	if _, err := repo.Track(t.Context()); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(work, ".git")); err == nil {
		t.Fatal("tracking made a .git directory in the project")
	}
}

func TestChangesListsWhatDiffersBetweenTwoMomentsAndBlobReadsFilesOfAMoment(t *testing.T) {
	work := t.TempDir()
	repo := snapshot.Repo{GitDir: filepath.Join(t.TempDir(), "shadow"), Workdir: work}
	write(t, work, "keep.txt", "one")
	write(t, work, "gone.txt", "bye")
	before, err := repo.Track(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	write(t, work, "keep.txt", "two")
	write(t, work, "made/new.txt", "fresh")
	if err := os.Remove(filepath.Join(work, "gone.txt")); err != nil {
		t.Fatal(err)
	}
	after, err := repo.Track(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	changes, err := repo.Changes(t.Context(), before, after)
	if err != nil {
		t.Fatal(err)
	}
	got := map[string]string{}
	for _, change := range changes {
		got[change.Path] = change.Status
	}
	want := map[string]string{"keep.txt": "modified", "made/new.txt": "added", "gone.txt": "deleted"}
	if len(got) != len(want) || got["keep.txt"] != "modified" || got["made/new.txt"] != "added" || got["gone.txt"] != "deleted" {
		t.Fatalf("changes = %v", got)
	}
	if body, present, err := repo.Blob(t.Context(), before, "keep.txt"); err != nil || !present || string(body) != "one" {
		t.Fatalf("keep.txt then = %q %v %v", body, present, err)
	}
	if _, present, err := repo.Blob(t.Context(), before, "made/new.txt"); err != nil || present {
		t.Fatalf("a file made later was present before: %v %v", present, err)
	}
	if changes, err := repo.Changes(t.Context(), after, after); err != nil || len(changes) != 0 {
		t.Fatalf("the same moment differs from itself: %v %v", changes, err)
	}
}
