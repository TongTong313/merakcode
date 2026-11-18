package conversation_test

import (
	"errors"
	"os"
	"path/filepath"
	"testing"

	"github.com/TongTong313/merakcode/merak/engine"
	"github.com/TongTong313/merakcode/merak/engine/agent/conversation"
	"github.com/TongTong313/merakcode/merak/engine/agent/loop"
	"github.com/TongTong313/merakcode/merak/engine/agent/model"
	"github.com/TongTong313/merakcode/merak/engine/agent/model/fake"
	"github.com/TongTong313/merakcode/merak/engine/agent/permission"
	"github.com/TongTong313/merakcode/merak/engine/feature/review"
	"github.com/TongTong313/merakcode/merak/engine/infra/errorcode"
	"github.com/TongTong313/merakcode/merak/engine/infra/event"
	"github.com/TongTong313/merakcode/merak/engine/infra/git"
	"github.com/TongTong313/merakcode/merak/testkit/enginetest"
)

// reviewSession makes a conversation in a repository where the agent, in one turn, changed README.md and added
// new.txt.
func reviewSession(t *testing.T) (*engine.Engine, event.ID, string) {
	t.Helper()
	e, repo, ctx := enginetest.CodeEngine(t,
		enginetest.IntegrationCall("write_file", map[string]any{"path": "README.md", "content": "Baseline\nchanged\n"}),
		enginetest.IntegrationCall("write_file", map[string]any{"path": "new.txt", "content": "new\n"}),
		fake.Reply{Text: "Done."},
	)
	id, err := e.CreateSession(ctx, conversation.SessionOptions{Provider: "fake", Model: "main", Workdir: repo, Mode: permission.ModeTakeover})
	if err != nil {
		t.Fatal(err)
	}
	facts, stop := e.Subscribe(event.Filter{Scope: event.Scope{Session: id}, Types: []event.Type{loop.TurnFinished}})
	defer stop()
	if err := e.Send(ctx, id, []model.Part{{Text: "Change things"}}); err != nil {
		t.Fatal(err)
	}
	select {
	case <-facts:
	case <-ctx.Done():
		t.Fatal("the turn did not finish")
	}
	return e, id, repo
}

func write(t *testing.T, path, text string) {
	t.Helper()
	if err := os.WriteFile(path, []byte(text), 0o600); err != nil {
		t.Fatal(err)
	}
}

func pending(t *testing.T, e *engine.Engine, id event.ID) map[string]git.Change {
	t.Helper()
	changes, err := e.RepoDiff(t.Context(), "", "", id, "")
	if err != nil {
		t.Fatal(err)
	}
	result := map[string]git.Change{}
	for _, change := range changes {
		result[change.Path] = change
	}
	return result
}

func TestAnAcceptedFileLeavesTheReviewAndTheOthersStay(t *testing.T) {
	e, id, repo := reviewSession(t)
	before := pending(t, e, id)
	if len(before) != 2 {
		t.Fatalf("pending before the decision: %v", before)
	}
	status, err := e.ReviewAccept(t.Context(), id, "", []review.File{{File: "README.md", Version: before["README.md"].Version}})
	if err != nil {
		t.Fatal(err)
	}
	after := pending(t, e, id)
	if _, left := after["README.md"]; left || len(after) != 1 || after["new.txt"].Version != before["new.txt"].Version {
		t.Fatalf("pending after accepting README.md: %v", after)
	}
	if status.Last == nil || status.Last.Decision != "accept" || status.Last.Count != 1 {
		t.Fatalf("status after accepting: %+v", status)
	}
	if got, _ := os.ReadFile(filepath.Join(repo, "README.md")); string(got) != "Baseline\nchanged\n" {
		t.Fatalf("accepting changed the working file: %q", got)
	}
}

func read(t *testing.T, path string) string {
	t.Helper()
	data, err := os.ReadFile(path)
	if err != nil {
		return "<missing>"
	}
	return string(data)
}

func TestARejectedFileGoesBackToWhereTheConversationFoundItAndAddedFilesAreRemoved(t *testing.T) {
	e, id, repo := reviewSession(t)
	changes := pending(t, e, id)
	files := []review.File{
		{File: "README.md", Version: changes["README.md"].Version},
		{File: "new.txt", Version: changes["new.txt"].Version},
	}
	status, err := e.ReviewReject(t.Context(), id, "", files)
	if err != nil {
		t.Fatal(err)
	}
	if got := read(t, filepath.Join(repo, "README.md")); got != "Baseline\n" {
		t.Fatalf("README.md after rejecting: %q", got)
	}
	if got := read(t, filepath.Join(repo, "new.txt")); got != "<missing>" {
		t.Fatalf("new.txt after rejecting: %q", got)
	}
	if left := pending(t, e, id); len(left) != 0 {
		t.Fatalf("pending after rejecting everything: %v", left)
	}
	if status.Last == nil || status.Last.Decision != "reject" || status.Last.Count != 2 {
		t.Fatalf("status: %+v", status)
	}
}

func TestAnAnswerAboutAChangeThatIsOutOfDateIsRefusedAndChangesNothing(t *testing.T) {
	e, id, repo := reviewSession(t)
	changes := pending(t, e, id)
	write(t, filepath.Join(repo, "README.md"), "Baseline\nchanged again\n")
	_, err := e.ReviewReject(t.Context(), id, "", []review.File{
		{File: "new.txt", Version: changes["new.txt"].Version},
		{File: "README.md", Version: changes["README.md"].Version},
	})
	var failure *errorcode.Error
	if !errors.As(err, &failure) || failure.Code != errorcode.ReviewStale {
		t.Fatalf("a stale decision: %v", err)
	}
	if got := read(t, filepath.Join(repo, "new.txt")); got != "new\n" {
		t.Fatalf("a refused decision still changed new.txt: %q", got)
	}
	if status, _ := e.ReviewStatus(t.Context(), id); status.Last != nil {
		t.Fatalf("a refused decision was recorded: %+v", status)
	}
}

func TestAcceptingSomeHunksKeepsTheRestInTheReviewAndRejectingSomeWritesTheGivenText(t *testing.T) {
	e, id, repo := reviewSession(t)
	changes := pending(t, e, id)
	// The client worked out the text for "accept the first hunk only"
	accepted := "Baseline\nchanged\n"
	if _, err := e.ReviewAccept(t.Context(), id, "", []review.File{{File: "README.md", Version: changes["README.md"].Version, Text: &accepted}}); err != nil {
		t.Fatal(err)
	}
	write(t, filepath.Join(repo, "README.md"), "Baseline\nchanged\nlater\n")
	now := pending(t, e, id)["README.md"]
	if now.Before != "Baseline\nchanged\n" || now.After != "Baseline\nchanged\nlater\n" {
		t.Fatalf("the review after accepting: before=%q after=%q", now.Before, now.After)
	}
	kept := "Baseline\nchanged\n"
	if _, err := e.ReviewReject(t.Context(), id, "", []review.File{{File: "README.md", Version: now.Version, Text: &kept}}); err != nil {
		t.Fatal(err)
	}
	if got := read(t, filepath.Join(repo, "README.md")); got != "Baseline\nchanged\n" {
		t.Fatalf("README.md after rejecting a hunk: %q", got)
	}
	if _, left := pending(t, e, id)["README.md"]; left {
		t.Fatal("a file equal to its accepted contents is still pending")
	}
}

func TestUndoPutsBackTheLastDecisionAndRefusesWhenTheFileMovedOn(t *testing.T) {
	e, id, repo := reviewSession(t)
	changes := pending(t, e, id)
	if _, err := e.ReviewReject(t.Context(), id, "", []review.File{{File: "new.txt", Version: changes["new.txt"].Version}}); err != nil {
		t.Fatal(err)
	}
	status, err := e.ReviewUndo(t.Context(), id)
	if err != nil {
		t.Fatal(err)
	}
	if got := read(t, filepath.Join(repo, "new.txt")); got != "new\n" || status.Last != nil {
		t.Fatalf("after undoing a rejection: file %q, status %+v", got, status)
	}
	if _, err := e.ReviewAccept(t.Context(), id, "", []review.File{{File: "README.md", Version: pending(t, e, id)["README.md"].Version}}); err != nil {
		t.Fatal(err)
	}
	if _, err := e.ReviewUndo(t.Context(), id); err != nil {
		t.Fatal(err)
	}
	if _, back := pending(t, e, id)["README.md"]; !back {
		t.Fatal("an accepted file did not come back after undo")
	}
	// A rejection whose file was edited afterwards cannot be undone without losing the edit
	if _, err := e.ReviewReject(t.Context(), id, "", []review.File{{File: "new.txt", Version: pending(t, e, id)["new.txt"].Version}}); err != nil {
		t.Fatal(err)
	}
	write(t, filepath.Join(repo, "new.txt"), "someone else\n")
	_, err = e.ReviewUndo(t.Context(), id)
	var failure *errorcode.Error
	if !errors.As(err, &failure) || failure.Code != errorcode.NothingToUndo {
		t.Fatalf("undo after an edit: %v", err)
	}
	if got := read(t, filepath.Join(repo, "new.txt")); got != "someone else\n" {
		t.Fatalf("a refused undo changed the file: %q", got)
	}
}

func TestRejectingADeletedFileBringsItBackAndRejectingABinaryFileRestoresItsBytes(t *testing.T) {
	e, repo, ctx := enginetest.CodeEngine(t,
		enginetest.IntegrationCall("bash", map[string]any{"command": "rm README.md"}),
		enginetest.IntegrationCall("write_file", map[string]any{"path": "data.bin", "content": "\t\u0000\t"}),
		fake.Reply{Text: "Done."},
	)
	binary := []byte{0, 1, 2, 3, 0xff}
	if err := os.WriteFile(filepath.Join(repo, "data.bin"), binary, 0o600); err != nil {
		t.Fatal(err)
	}
	enginetest.FixtureGit(t, repo, "add", ".")
	enginetest.FixtureGit(t, repo, "commit", "-m", "binary")
	id, err := e.CreateSession(ctx, conversation.SessionOptions{Provider: "fake", Model: "main", Workdir: repo, Mode: permission.ModeTakeover})
	if err != nil {
		t.Fatal(err)
	}
	facts, stop := e.Subscribe(event.Filter{Scope: event.Scope{Session: id}, Types: []event.Type{loop.TurnFinished}})
	defer stop()
	if err := e.Send(ctx, id, []model.Part{{Text: "Delete and overwrite"}}); err != nil {
		t.Fatal(err)
	}
	select {
	case <-facts:
	case <-ctx.Done():
		t.Fatal("the turn did not finish")
	}
	changes := pending(t, e, id)
	if len(changes) != 2 || !changes["data.bin"].Binary || changes["README.md"].Status != "deleted" {
		t.Fatalf("pending: %v", changes)
	}
	files := []review.File{
		{File: "README.md", Version: changes["README.md"].Version},
		{File: "data.bin", Version: changes["data.bin"].Version},
	}
	if _, err := e.ReviewReject(ctx, id, "", files); err != nil {
		t.Fatal(err)
	}
	if got := read(t, filepath.Join(repo, "README.md")); got != "Baseline\n" {
		t.Fatalf("README.md after rejecting its deletion: %q", got)
	}
	if got := read(t, filepath.Join(repo, "data.bin")); got != string(binary) {
		t.Fatalf("data.bin after rejecting: %q", got)
	}
}

func TestTheReviewOfAConversationListsOnlyFilesTheAgentChanged(t *testing.T) {
	e, id, repo := reviewSession(t)
	write(t, filepath.Join(repo, "manual.txt"), "by hand\n")
	write(t, filepath.Join(repo, "other.txt"), "also by hand\n")
	changes := pending(t, e, id)
	if _, leaked := changes["manual.txt"]; leaked || len(changes) != 2 {
		t.Fatalf("pending: %v", changes)
	}
}

func TestAConversationThatHasRunNoTurnListsWhatDiffersFromItsStart(t *testing.T) {
	e, repo, ctx := enginetest.CodeEngine(t)
	id, err := e.CreateSession(ctx, conversation.SessionOptions{Provider: "fake", Model: "main", Workdir: repo})
	if err != nil {
		t.Fatal(err)
	}
	write(t, filepath.Join(repo, "README.md"), "Baseline\nedited\n")
	if changes := pending(t, e, id); len(changes) != 1 || changes["README.md"].After != "Baseline\nedited\n" {
		t.Fatalf("pending: %v", changes)
	}
}
