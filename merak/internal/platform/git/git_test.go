package git_test

import (
	"context"
	"io/fs"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	"github.com/TongTong313/merakcode/merak/internal/platform/git"
)

func command(t *testing.T, directory string, args ...string) string {
	t.Helper()
	cmd := exec.Command("git", args...)
	cmd.Dir = directory
	output, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("git %v: %v\n%s", args, err, output)
	}
	return string(output)
}

func repository(t *testing.T) string {
	t.Helper()
	directory := t.TempDir()
	t.Cleanup(func() {
		// Git creates read-only objects on Windows; make fixture files removable.
		_ = filepath.WalkDir(directory, func(path string, entry fs.DirEntry, err error) error {
			if err == nil && !entry.IsDir() {
				_ = os.Chmod(path, 0600)
			}
			return nil
		})
	})
	command(t, directory, "init", "-b", "main")
	command(t, directory, "config", "user.name", "Fixture")
	command(t, directory, "config", "user.email", "fixture@example.invalid")
	command(t, directory, "config", "core.autocrlf", "false")
	write(t, directory, "note.txt", "original\n")
	command(t, directory, "add", ".")
	command(t, directory, "commit", "-m", "Fixture baseline")
	return directory
}

func write(t *testing.T, directory, name, body string) {
	t.Helper()
	if err := os.WriteFile(filepath.Join(directory, name), []byte(body), 0600); err != nil {
		t.Fatal(err)
	}
}

func TestStatusReportsRealWorkspaceChanges(t *testing.T) {
	for _, test := range []struct {
		name, file, status string
		prepare            func(*testing.T, string)
	}{
		{"modified", "note.txt", "modified", func(t *testing.T, dir string) { write(t, dir, "note.txt", "changed\n") }},
		{"untracked with spaces", "new file.txt", "untracked", func(t *testing.T, dir string) { write(t, dir, "new file.txt", "new\n") }},
		{"deleted", "note.txt", "deleted", func(t *testing.T, dir string) {
			if err := os.Remove(filepath.Join(dir, "note.txt")); err != nil {
				t.Fatal(err)
			}
		}},
		{"renamed", "renamed.txt", "renamed", func(t *testing.T, dir string) { command(t, dir, "mv", "note.txt", "renamed.txt") }},
	} {
		t.Run(test.name, func(t *testing.T) {
			dir := repository(t)
			test.prepare(t, dir)
			status, err := git.Status(context.Background(), dir)
			if err != nil {
				t.Fatal(err)
			}
			if status.Branch != "main" || len(status.Head) != 40 {
				t.Fatalf("identity=%+v", status)
			}
			if len(status.Files) != 1 || status.Files[0].Path != test.file || status.Files[0].Status != test.status {
				t.Fatalf("files=%+v", status.Files)
			}
		})
	}
}

func TestBranchesAndCheckoutPreserveFilesOnFailure(t *testing.T) {
	for _, test := range []struct {
		name, branch    string
		dirty, accepted bool
	}{
		{"switches existing branch", "feature", false, true},
		{"rejects unknown branch", "missing", false, false},
		{"rejects option injection", "--orphan=other", false, false},
		{"preserves conflicting changes", "feature", true, false},
	} {
		t.Run(test.name, func(t *testing.T) {
			dir := repository(t)
			original := strings.TrimSpace(command(t, dir, "rev-parse", "HEAD"))
			command(t, dir, "switch", "-c", "feature")
			write(t, dir, "note.txt", "feature\n")
			command(t, dir, "commit", "-am", "Feature fixture")
			command(t, dir, "switch", "main")
			branches, err := git.Branches(context.Background(), dir)
			if err != nil || len(branches) != 2 || branches[0].Name != "feature" || branches[0].Current || branches[1].Name != "main" || !branches[1].Current {
				t.Fatalf("branches=%+v err=%v", branches, err)
			}
			if test.dirty {
				write(t, dir, "note.txt", "local changes\n")
			}
			err = git.Checkout(context.Background(), dir, test.branch)
			if (err == nil) != test.accepted {
				t.Fatalf("checkout=%v", err)
			}
			head, err := git.Current(context.Background(), dir)
			if err != nil || (head != original) != test.accepted {
				t.Fatalf("head=%s err=%v", head, err)
			}
			if test.dirty {
				body, err := os.ReadFile(filepath.Join(dir, "note.txt"))
				if err != nil || string(body) != "local changes\n" {
					t.Fatalf("lost working file: %s %v", body, err)
				}
			}
		})
	}
}

func TestDiffComparesWorkspaceWithSelectedCommit(t *testing.T) {
	for _, test := range []struct {
		name, path, before, after string
		binary                    bool
		prepare                   func(*testing.T, string)
	}{
		{"modified", "note.txt", "original\n", "changed\n", false, func(t *testing.T, dir string) { write(t, dir, "note.txt", "changed\n") }},
		{"untracked", "new file.txt", "", "new\n", false, func(t *testing.T, dir string) { write(t, dir, "new file.txt", "new\n") }},
		{"deleted", "note.txt", "original\n", "", false, func(t *testing.T, dir string) {
			if err := os.Remove(filepath.Join(dir, "note.txt")); err != nil {
				t.Fatal(err)
			}
		}},
		{"renamed", "renamed.txt", "original\n", "original\n", false, func(t *testing.T, dir string) { command(t, dir, "mv", "note.txt", "renamed.txt") }},
		{"binary", "note.txt", "", "", true, func(t *testing.T, dir string) { write(t, dir, "note.txt", "\x00\x01") }},
	} {
		t.Run(test.name, func(t *testing.T) {
			dir := repository(t)
			base, err := git.Current(context.Background(), dir)
			if err != nil {
				t.Fatal(err)
			}
			test.prepare(t, dir)
			files, err := git.Diff(context.Background(), dir, base)
			if err != nil {
				t.Fatal(err)
			}
			if len(files) != 1 || files[0].Path != test.path || files[0].Before != test.before || files[0].After != test.after || files[0].Binary != test.binary || files[0].Version == "" {
				t.Fatalf("diff=%+v", files)
			}
		})
	}
}

func TestRepositoryFilesAreRelativeToProjectDirectory(t *testing.T) {
	for _, name := range []string{"status", "diff"} {
		t.Run(name, func(t *testing.T) {
			root := repository(t)
			dir := filepath.Join(root, "project")
			if err := os.Mkdir(dir, 0700); err != nil {
				t.Fatal(err)
			}
			write(t, dir, "source.txt", "before\n")
			command(t, root, "add", ".")
			command(t, root, "commit", "-m", "Nested fixture")
			base, err := git.Current(context.Background(), dir)
			if err != nil {
				t.Fatal(err)
			}
			write(t, dir, "source.txt", "after\n")
			write(t, root, "note.txt", "outside project\n")
			if name == "status" {
				state, err := git.Status(context.Background(), dir)
				if err != nil || len(state.Files) != 1 || state.Files[0].Path != "source.txt" {
					t.Fatalf("state=%+v err=%v", state, err)
				}
				return
			}
			changes, err := git.Diff(context.Background(), dir, base)
			if err != nil || len(changes) != 1 || changes[0].Path != "source.txt" || changes[0].Before != "before\n" || changes[0].After != "after\n" {
				t.Fatalf("changes=%+v err=%v", changes, err)
			}
		})
	}
}

func TestDiffRejectsContentsBeyondProtocolBudget(t *testing.T) {
	for _, historical := range []bool{false, true} {
		name := "working file"
		if historical {
			name = "baseline blob"
		}
		t.Run(name, func(t *testing.T) {
			dir := repository(t)
			write(t, dir, "note.txt", strings.Repeat("x", 4<<20))
			if historical {
				command(t, dir, "commit", "-am", "Large fixture")
				write(t, dir, "note.txt", "small\n")
			}
			base, err := git.Current(context.Background(), dir)
			if err != nil {
				t.Fatal(err)
			}
			if _, err := git.Diff(context.Background(), dir, base); err == nil {
				t.Fatal("oversized contents were accepted")
			}
		})
	}
}
