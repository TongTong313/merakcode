package engine_test

import (
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"os"
	"path/filepath"
	"testing"

	"github.com/TongTong313/merakcode/merak/engine"
	"github.com/TongTong313/merakcode/merak/internal/platform/errorcode"
)

func sum(body string) string {
	digest := sha256.Sum256([]byte(body))
	return hex.EncodeToString(digest[:])
}

func TestTheEditorReadsFilesWithTheirChecksumAndBaseline(t *testing.T) {
	e, repo, ctx := codeEngine(t)
	write := func(name, body string) {
		t.Helper()
		if err := os.WriteFile(filepath.Join(repo, name), []byte(body), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	write("a.txt", "one\n")
	fixtureGit(t, repo, "add", "a.txt")
	fixtureGit(t, repo, "commit", "-m", "Add a")
	write("a.txt", "two\n")
	write("new.txt", "fresh\n")
	png, _ := base64.StdEncoding.DecodeString("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/a3sAAAAASUVORK5CYII=")
	write("pixel.png", string(png))
	write("blob.bin", "\xff\xfe\x00\x01")

	tests := []struct {
		name  string
		check func(t *testing.T, got engine.FileContent)
	}{
		{"a.txt", func(t *testing.T, got engine.FileContent) {
			if got.Type != "text" || got.Content != "two\n" || got.Checksum != sum("two\n") || got.Head == nil || *got.Head != "one\n" || got.Missing {
				t.Fatalf("modified file: %+v", got)
			}
		}},
		{"new.txt", func(t *testing.T, got engine.FileContent) {
			if got.Content != "fresh\n" || got.Head != nil {
				t.Fatalf("an untracked file has no baseline: %+v", got)
			}
		}},
		{"pixel.png", func(t *testing.T, got engine.FileContent) {
			if got.Type != "binary" || got.MIME != "image/png" || got.Content != base64.StdEncoding.EncodeToString(png) {
				t.Fatalf("image: %+v", got)
			}
		}},
		{"blob.bin", func(t *testing.T, got engine.FileContent) {
			if got.Type != "binary" || got.Content != "" || got.MIME != "" {
				t.Fatalf("a binary file is not shown as text: %+v", got)
			}
		}},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			got, err := e.ReadFile(ctx, repo, test.name)
			if err != nil {
				t.Fatal(err)
			}
			test.check(t, got)
		})
	}

	t.Run("a deleted tracked file is read-only history", func(t *testing.T) {
		if err := os.Remove(filepath.Join(repo, "a.txt")); err != nil {
			t.Fatal(err)
		}
		got, err := e.ReadFile(ctx, repo, "a.txt")
		if err != nil || !got.Missing || got.Content != "one\n" || got.Checksum != "" {
			t.Fatalf("got=%+v err=%v", got, err)
		}
	})
	t.Run("a file that was never committed and is gone is an error", func(t *testing.T) {
		if _, err := e.ReadFile(ctx, repo, "never.txt"); err == nil {
			t.Fatal("no error")
		}
	})
}

func TestTheEditorSavesAFileOnlyOverTheVersionItRead(t *testing.T) {
	e, repo, ctx := codeEngine(t)
	file := filepath.Join(repo, "notes.txt")
	if err := os.WriteFile(file, []byte("first\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	read, err := e.ReadFile(ctx, repo, "notes.txt")
	if err != nil {
		t.Fatal(err)
	}
	saved, err := e.WriteFile(ctx, repo, "notes.txt", "second\n", read.Checksum, false)
	if err != nil || saved != sum("second\n") {
		t.Fatalf("saved=%q err=%v", saved, err)
	}
	if body, _ := os.ReadFile(file); string(body) != "second\n" {
		t.Fatalf("file=%q", body)
	}

	if err := os.WriteFile(file, []byte("external\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	_, err = e.WriteFile(ctx, repo, "notes.txt", "third\n", saved, false)
	var failure *engine.Error
	if !errors.As(err, &failure) || failure.Code != errorcode.FileChanged {
		t.Fatalf("a stale save: %v", err)
	}
	if body, _ := os.ReadFile(file); string(body) != "external\n" {
		t.Fatalf("a refused save changed the file: %q", body)
	}
	if _, err = e.WriteFile(ctx, repo, "notes.txt", "third\n", saved, true); err != nil {
		t.Fatalf("forced save: %v", err)
	}
	if body, _ := os.ReadFile(file); string(body) != "third\n" {
		t.Fatalf("file=%q", body)
	}
	if _, err = e.WriteFile(ctx, repo, "notes.txt", "fourth\n", "", false); err != nil {
		t.Fatalf("a save without a known version: %v", err)
	}

	for _, name := range []string{"../escape.txt", filepath.Join(filepath.Dir(repo), "escape.txt"), ".git/config", "sub/../../escape.txt"} {
		if _, err := e.WriteFile(ctx, repo, name, "x", "", false); err == nil {
			t.Fatalf("%q was written", name)
		}
	}
	if _, err := e.WriteFile(ctx, repo, file, "inside\n", "", false); err != nil {
		t.Fatalf("an absolute path inside the folder: %v", err)
	}
	if err := os.Remove(file); err != nil {
		t.Fatal(err)
	}
	if _, err := e.WriteFile(ctx, repo, "notes.txt", "again\n", sum("inside\n"), false); err == nil {
		t.Fatal("a file deleted after it was read was recreated over a stale version")
	}
}

func TestListingMarksIgnoredEntries(t *testing.T) {
	e, repo, ctx := codeEngine(t)
	for name, body := range map[string]string{".gitignore": "build/\n*.log\n", "build/out.txt": "x", "keep.txt": "k", "debug.log": "l"} {
		path := filepath.Join(repo, filepath.FromSlash(name))
		if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(path, []byte(body), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	nodes, err := e.ListFiles(ctx, repo, ".")
	if err != nil {
		t.Fatal(err)
	}
	ignored := map[string]bool{}
	for _, node := range nodes {
		ignored[node.Name] = node.Ignored
	}
	if !ignored["build"] || !ignored["debug.log"] || ignored["keep.txt"] || ignored[".gitignore"] {
		t.Fatalf("ignored=%v", ignored)
	}
	inside, err := e.ListFiles(ctx, repo, "build")
	if err != nil || len(inside) != 1 || !inside[0].Ignored {
		t.Fatalf("inside an ignored folder: %+v err=%v", inside, err)
	}
	plain := t.TempDir()
	if err := os.WriteFile(filepath.Join(plain, "a.log"), []byte("x"), 0o600); err != nil {
		t.Fatal(err)
	}
	nodes, err = e.ListFiles(ctx, plain, ".")
	if err != nil || len(nodes) != 1 || nodes[0].Ignored {
		t.Fatalf("outside git: %+v err=%v", nodes, err)
	}
}
