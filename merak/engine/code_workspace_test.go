package engine_test

import (
	"context"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"

	"github.com/TongTong313/merakcode/merak/engine"
	"github.com/TongTong313/merakcode/merak/engine/model"
	"github.com/TongTong313/merakcode/merak/engine/model/fake"
	"github.com/TongTong313/merakcode/merak/engine/workspace"
	"github.com/TongTong313/merakcode/merak/internal/platform/errorcode"
)

func codeEngine(t *testing.T, replies ...fake.Reply) (*engine.Engine, string, context.Context) {
	t.Helper()
	ctx, cancel := context.WithTimeout(t.Context(), 30*time.Second)
	t.Cleanup(cancel)
	repo := integrationRepository(t)
	e, err := engine.New(engine.Deps{Workdir: repo, DataDir: t.TempDir(), Providers: map[string]model.Provider{"fake": fake.New(t, replies...)}})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { e.Close() })
	return e, repo, ctx
}

func TestCommitPushAndAMessageWrittenByTheDefaultModel(t *testing.T) {
	e, repo, ctx := codeEngine(t, fake.Reply{Text: "\"Rewrite the greeting\"\n\nMore detail nobody asked for"})
	remote := filepath.Join(t.TempDir(), "remote.git")
	fixtureGit(t, filepath.Dir(remote), "init", "--bare", "-b", "main", remote)
	fixtureGit(t, repo, "remote", "add", "origin", remote)
	if err := os.WriteFile(filepath.Join(repo, "README.md"), []byte("Changed\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := e.RepoCommitMessage(ctx, repo); err == nil {
		t.Fatal("a message was written without a model")
	}
	e.SetDefaultModel("fake", "writer", "")
	message, err := e.RepoCommitMessage(ctx, repo)
	if err != nil || message != "Rewrite the greeting" {
		t.Fatalf("message=%q err=%v", message, err)
	}
	if status := fixtureGit(t, repo, "status", "--porcelain"); !strings.Contains(status, "README.md") {
		t.Fatal("writing a message must not commit anything")
	}
	if _, err := e.RepoCommit(ctx, repo, message, []string{"README.md"}); err != nil {
		t.Fatal(err)
	}
	if err := e.RepoPush(ctx, repo); err != nil {
		t.Fatal(err)
	}
	if got, want := fixtureGit(t, remote, "rev-parse", "refs/heads/main"), fixtureGit(t, repo, "rev-parse", "HEAD"); got != want {
		t.Fatalf("remote=%s local=%s", got, want)
	}
}

func TestAWorktreeKeyIsCreatedOnceAndAConversationUsingItIsToo(t *testing.T) {
	e, repo, ctx := codeEngine(t, fake.Reply{Text: "ok"})
	count := func() int { return strings.Count(fixtureGit(t, repo, "worktree", "list", "--porcelain"), "worktree ") }
	first, err := e.CreateWorktree(ctx, repo, "first-message-1", "")
	if err != nil {
		t.Fatal(err)
	}
	again, err := e.CreateWorktree(ctx, repo+"/", "first-message-1", "")
	if err != nil || again.Path != first.Path || again.Branch != first.Branch {
		t.Fatalf("the same key gave %+v then %+v (%v)", first, again, err)
	}
	if count() != 2 {
		t.Fatalf("git has %d worktrees, want 2", count())
	}
	if _, err := os.Stat(filepath.Join(first.Path, "README.md")); err != nil {
		t.Fatalf("the worktree has no files: %v", err)
	}
	other, err := e.CreateWorktree(ctx, repo, "second-key", "named/branch")
	if err != nil || other.Path == first.Path || other.Branch != "named/branch" {
		t.Fatalf("other=%+v err=%v", other, err)
	}
	listed, err := e.ListWorktrees(ctx, repo)
	if err != nil || len(listed) != 2 {
		t.Fatalf("listed=%+v err=%v", listed, err)
	}
	if _, err := e.CreateWorktree(ctx, t.TempDir(), "not-a-repo", ""); err == nil {
		t.Fatal("a worktree was made outside a repository")
	}

	one, err := e.CreateSession(ctx, engine.SessionOptions{Provider: "fake", Workdir: first.Path, Key: "chat-key"})
	if err != nil {
		t.Fatal(err)
	}
	two, err := e.CreateSession(ctx, engine.SessionOptions{Provider: "fake", Workdir: first.Path, Key: "chat-key"})
	if err != nil || two != one {
		t.Fatalf("one key made two sessions: %q %q (%v)", one, two, err)
	}
	if sessions, _ := e.ListSessions(ctx); len(sessions) != 1 {
		t.Fatalf("sessions=%d", len(sessions))
	}
}

func TestAWorktreeMergesBackIntoTheMainBranchAndIsRemoved(t *testing.T) {
	e, repo, ctx := codeEngine(t)
	tree, err := e.CreateWorktree(ctx, repo, "merge-me", "")
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(tree.Path, "feature.txt"), []byte("feature\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	fixtureGit(t, tree.Path, "add", ".")
	fixtureGit(t, tree.Path, "commit", "-m", "Feature")
	if err := e.MergeWorktree(ctx, tree.Path); err != nil {
		t.Fatal(err)
	}
	if body, err := os.ReadFile(filepath.Join(repo, "feature.txt")); err != nil || string(body) != "feature\n" {
		t.Fatalf("the main branch did not get the work: %q %v", body, err)
	}
	if err := e.RemoveWorktree(ctx, tree.Path); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(tree.Path); err == nil {
		t.Fatal("the worktree folder is still there")
	}
	if got := strings.Count(fixtureGit(t, repo, "worktree", "list", "--porcelain"), "worktree "); got != 1 {
		t.Fatalf("git still lists %d worktrees", got)
	}
	if err := e.RemoveWorktree(ctx, repo); err == nil {
		t.Fatal("the main worktree was removed")
	}
	if err := e.MergeWorktree(ctx, filepath.Join(t.TempDir(), "stranger")); err == nil {
		t.Fatal("a folder that is not one of ours was merged")
	}
}

func TestFileStatusIdentityAndFind(t *testing.T) {
	e, repo, ctx := codeEngine(t)
	if err := os.MkdirAll(filepath.Join(repo, "src", "deep"), 0o755); err != nil {
		t.Fatal(err)
	}
	for name, body := range map[string]string{"src/app.ts": "a", "src/deep/Helper.ts": "b", ".gitignore": "ignored.log\n", "ignored.log": "x", "src/deep/untracked.txt": "u"} {
		if err := os.WriteFile(filepath.Join(repo, filepath.FromSlash(name)), []byte(body), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	fixtureGit(t, repo, "add", "src/app.ts", ".gitignore")
	fixtureGit(t, repo, "commit", "-m", "Add app")
	if err := os.WriteFile(filepath.Join(repo, "src", "app.ts"), []byte("changed"), 0o600); err != nil {
		t.Fatal(err)
	}

	status, err := e.FileStatus(ctx, repo, "src/app.ts")
	if err != nil || status.Status != "modified" || status.Path != "src/app.ts" {
		t.Fatalf("status=%+v err=%v", status, err)
	}
	if status, err = e.FileStatus(ctx, repo, "src/deep/untracked.txt"); err != nil || status.Status != "untracked" {
		t.Fatalf("status=%+v err=%v", status, err)
	}
	if status, err = e.FileStatus(ctx, repo, ".gitignore"); err != nil || status.Status != "" {
		t.Fatalf("a clean file has status %+v err=%v", status, err)
	}

	canonical, err := workspace.Canonical(repo)
	if err != nil {
		t.Fatal(err)
	}
	for _, spelling := range []string{repo, filepath.ToSlash(repo) + "/"} {
		identity, err := e.FileIdentity(ctx, spelling, "src/app.ts")
		if err != nil || identity.Directory != canonical || identity.Root != canonical || identity.Path != "src/app.ts" {
			t.Fatalf("identity of %q = %+v err=%v", spelling, identity, err)
		}
	}
	plain := t.TempDir()
	if identity, err := e.FileIdentity(ctx, plain, "."); err != nil || identity.Root != "" {
		t.Fatalf("a folder without git has root %q err=%v", identity.Root, err)
	}

	found, err := e.FindFiles(ctx, repo, "HELPER", 10)
	if err != nil || len(found) != 1 || found[0] != "src/deep/Helper.ts" {
		t.Fatalf("found=%v err=%v", found, err)
	}
	if found, _ = e.FindFiles(ctx, repo, "ignored", 10); len(found) != 0 {
		t.Fatalf("an ignored file was found: %v", found)
	}
	if found, _ = e.FindFiles(ctx, repo, "untracked", 10); len(found) != 1 {
		t.Fatalf("a new file was not found: %v", found)
	}
	if found, _ = e.FindFiles(ctx, repo, "s", 1); len(found) != 1 {
		t.Fatalf("limit ignored: %v", found)
	}
}

func TestAWorktreeCanStartFromAnotherBranchWithoutTouchingTheMainCheckout(t *testing.T) {
	e, repo, ctx := codeEngine(t)
	main := strings.TrimSpace(fixtureGit(t, repo, "branch", "--show-current"))
	fixtureGit(t, repo, "switch", "--quiet", "-c", "feature")
	if err := os.WriteFile(filepath.Join(repo, "base.txt"), []byte("from feature\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	fixtureGit(t, repo, "add", ".")
	fixtureGit(t, repo, "commit", "-m", "feature base")
	fixtureGit(t, repo, "switch", "--quiet", main)

	tree, err := e.CreateWorktreeFrom(ctx, repo, "from-feature", "", "feature")
	if err != nil {
		t.Fatal(err)
	}
	if body, err := os.ReadFile(filepath.Join(tree.Path, "base.txt")); err != nil || string(body) != "from feature\n" {
		t.Fatalf("the worktree does not start from the chosen branch: %q %v", body, err)
	}
	if tree.Branch != "merak/chat/from-feature" {
		t.Fatalf("the worktree works on %q, not on a branch of its own", tree.Branch)
	}
	if got := strings.TrimSpace(fixtureGit(t, repo, "branch", "--show-current")); got != main {
		t.Fatalf("the main checkout moved to %q", got)
	}
	if _, err := e.CreateWorktreeFrom(ctx, repo, "missing-base", "", "no-such-branch"); err == nil {
		t.Fatal("a worktree started from a branch that does not exist")
	}
}

func TestAFolderMadeByTheEngineAsAWorktreeSaysSoInItsIdentity(t *testing.T) {
	e, repo, ctx := codeEngine(t)
	tree, err := e.CreateWorktree(ctx, repo, "managed-one", "")
	if err != nil {
		t.Fatal(err)
	}
	identity, err := e.FileIdentity(ctx, tree.Path, ".")
	if err != nil || identity.Worktree != "managed-one" {
		t.Fatalf("worktree identity=%+v err=%v", identity, err)
	}
	if identity, err = e.FileIdentity(ctx, repo, "."); err != nil || identity.Worktree != "" {
		t.Fatalf("the main checkout is not a worktree: %+v err=%v", identity, err)
	}
}

func TestAFileIdentityNamesAPathWithTheSpellingTheDiskHas(t *testing.T) {
	e, repo, ctx := codeEngine(t)
	if err := os.MkdirAll(filepath.Join(repo, "Src", "Deep"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(repo, "Src", "Deep", "Notes.TXT"), []byte("x"), 0o600); err != nil {
		t.Fatal(err)
	}
	for _, asked := range []string{"Src/Deep/Notes.TXT", "src/deep/notes.txt", "SRC/DEEP/NOTES.TXT", "./src/../Src/deep/notes.txt"} {
		identity, err := e.FileIdentity(ctx, repo, asked)
		if err != nil {
			t.Fatal(err)
		}
		_, insensitive := os.Stat(filepath.Join(repo, "src", "deep", "notes.txt"))
		if asked == "Src/Deep/Notes.TXT" || insensitive == nil {
			if identity.Path != "Src/Deep/Notes.TXT" {
				t.Fatalf("asked %q, the disk spells it %q", asked, identity.Path)
			}
			continue
		}
		if identity.Path == "Src/Deep/Notes.TXT" {
			t.Fatalf("a case-sensitive volume must not merge %q into another file", asked)
		}
	}
	if identity, err := e.FileIdentity(ctx, repo, "new/not/yet.txt"); err != nil || identity.Path != "new/not/yet.txt" {
		t.Fatalf("a path that does not exist stays as asked: %+v err=%v", identity, err)
	}
}

func TestAFolderThatIsGoneIsReportedWithItsOwnCode(t *testing.T) {
	e, repo, ctx := codeEngine(t)
	gone := filepath.Join(repo, "removed-folder")
	_, err := e.FileIdentity(ctx, gone, ".")
	var failure *engine.Error
	if !errors.As(err, &failure) || failure.Code != errorcode.DirectoryMissing {
		t.Fatalf("identity of a missing folder: %v", err)
	}
	if _, err = e.ListFiles(ctx, gone, "."); !errors.As(err, &failure) || failure.Code != errorcode.DirectoryMissing {
		t.Fatalf("listing a missing folder: %v", err)
	}
}

// linkFolder makes link another way into target: a symbolic link, or on Windows a junction, which needs no privilege.
func linkFolder(t *testing.T, target, link string) {
	t.Helper()
	if runtime.GOOS == "windows" {
		if out, err := exec.Command("cmd", "/c", "mklink", "/J", link, target).CombinedOutput(); err != nil {
			t.Skipf("no junctions here: %v %s", err, out)
		}
		return
	}
	if err := os.Symlink(target, link); err != nil {
		t.Skipf("no symbolic links here: %v", err)
	}
}

func TestAFileReachedThroughALinkedFolderHasTheIdentityOfItsRealPlace(t *testing.T) {
	e, repo, ctx := codeEngine(t)
	if err := os.MkdirAll(filepath.Join(repo, "actual"), 0o755); err != nil {
		t.Fatal(err)
	}
	linkFolder(t, filepath.Join(repo, "actual"), filepath.Join(repo, "alias"))
	if err := os.WriteFile(filepath.Join(repo, "actual", "kept.txt"), []byte("x"), 0o600); err != nil {
		t.Fatal(err)
	}
	// The file need not exist: a deleted file keeps the place its tab and draft were stored under
	for _, asked := range []string{"alias/kept.txt", "actual/kept.txt", "alias/removed.txt", "actual/removed.txt", "alias/new/deep.txt"} {
		identity, err := e.FileIdentity(ctx, repo, asked)
		if err != nil {
			t.Fatal(err)
		}
		want := "actual/" + asked[strings.Index(asked, "/")+1:]
		if identity.Path != want {
			t.Errorf("asked %q, identity %q; want %q", asked, identity.Path, want)
		}
	}
	outside := t.TempDir()
	linkFolder(t, outside, filepath.Join(repo, "elsewhere"))
	identity, err := e.FileIdentity(ctx, repo, "elsewhere/file.txt")
	if err != nil || identity.Path != "elsewhere/file.txt" {
		t.Errorf("a link that leaves the folder keeps the path as asked: %+v err=%v", identity, err)
	}
}

func TestAnAbsolutePathInsideTheFolderIsNamedRelativeToItWhateverSpellingAskedForIt(t *testing.T) {
	e, repo, ctx := codeEngine(t)
	alias := filepath.Join(t.TempDir(), "alias")
	linkFolder(t, repo, alias)
	for _, c := range []struct{ directory, asked string }{
		{repo, filepath.Join(repo, "src", "app.ts")},
		{alias, filepath.Join(alias, "src", "app.ts")},
		{alias, filepath.Join(repo, "src", "app.ts")},
		{repo, filepath.Join(alias, "src", "app.ts")},
		{alias, filepath.ToSlash(filepath.Join(alias, "src", "new.ts"))},
	} {
		identity, err := e.FileIdentity(ctx, c.directory, c.asked)
		want := "src/" + filepath.Base(c.asked)
		if err != nil || identity.Path != want {
			t.Errorf("identity of %q in %q = %+v err=%v; want path %q", c.asked, c.directory, identity, err, want)
		}
	}
	outside := filepath.Join(t.TempDir(), "other.txt")
	identity, err := e.FileIdentity(ctx, repo, outside)
	if err != nil || filepath.ToSlash(identity.Path) != filepath.ToSlash(outside) {
		t.Errorf("a path outside the folder stays as asked: %+v err=%v", identity, err)
	}
}
