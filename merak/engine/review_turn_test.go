package engine_test

import (
	"os"
	"path/filepath"
	"testing"

	"github.com/TongTong313/merakcode/merak/engine"
	"github.com/TongTong313/merakcode/merak/engine/event"
	"github.com/TongTong313/merakcode/merak/engine/model/fake"
	"github.com/TongTong313/merakcode/merak/engine/permission"
	"github.com/TongTong313/merakcode/merak/engine/review"
)

func turnRig(t *testing.T) (*chatRig, event.ID, event.ID) {
	r := newChatRig(t, engine.SessionOptions{Mode: permission.ModeTakeover},
		integrationCall("write_file", map[string]any{"path": "a.txt", "content": "one\n"}),
		fake.Reply{Text: "First done."},
		integrationCall("write_file", map[string]any{"path": "a.txt", "content": "two\n"}),
		integrationCall("write_file", map[string]any{"path": "b.txt", "content": "bee\n"}),
		fake.Reply{Text: "Second done."},
	)
	first := r.say("First question")
	second := r.say("Second question")
	return r, first, second
}

func turnChanges(t *testing.T, r *chatRig, message event.ID) map[string]string {
	t.Helper()
	changes, err := r.e.RepoDiff(r.ctx, "", "", r.id, message)
	if err != nil {
		t.Fatal(err)
	}
	result := map[string]string{}
	for _, change := range changes {
		result[change.Path] = change.Status + ":" + change.Before + ">" + change.After
	}
	return result
}

func TestTheReviewOfATurnShowsOnlyWhatThatTurnChanged(t *testing.T) {
	r, first, second := turnRig(t)
	one := turnChanges(t, r, first)
	if len(one) != 1 || one["a.txt"] != "added:>one\n" {
		t.Fatalf("first turn: %v", one)
	}
	two := turnChanges(t, r, second)
	if len(two) != 2 || two["a.txt"] != "modified:one\n>two\n" || two["b.txt"] != "added:>bee\n" {
		t.Fatalf("second turn: %v", two)
	}
	if last := turnChanges(t, r, review.LastTurn); len(last) != 2 || last["a.txt"] != two["a.txt"] {
		t.Fatalf("the last turn: %v", last)
	}
}

func TestDecisionsOnATurnRejectToTheStartOfTheTurnAndAcceptHideTheFile(t *testing.T) {
	r, _, second := turnRig(t)
	changes, err := r.e.RepoDiff(r.ctx, "", "", r.id, second)
	if err != nil {
		t.Fatal(err)
	}
	versions := map[string]string{}
	for _, change := range changes {
		versions[change.Path] = change.Version
	}
	if _, err := r.e.ReviewReject(r.ctx, r.id, second, []review.File{{File: "a.txt", Version: versions["a.txt"]}}); err != nil {
		t.Fatal(err)
	}
	if body, _ := os.ReadFile(filepath.Join(r.dir, "a.txt")); string(body) != "one\n" {
		t.Fatalf("a.txt after rejecting the turn's change: %q", body)
	}
	if _, err := r.e.ReviewAccept(r.ctx, r.id, second, []review.File{{File: "b.txt", Version: versions["b.txt"]}}); err != nil {
		t.Fatal(err)
	}
	if left := turnChanges(t, r, second); len(left) != 0 {
		t.Fatalf("the turn still shows %v", left)
	}
	if _, err := r.e.ReviewUndo(r.ctx, r.id); err != nil {
		t.Fatal(err)
	}
	if left := turnChanges(t, r, second); len(left) != 1 || left["b.txt"] != "added:>bee\n" {
		t.Fatalf("after undoing the acceptance: %v", left)
	}
}

func TestFilesTheAgentDidNotTouchDuringATurnAreNotInItsReview(t *testing.T) {
	r, first, second := turnRig(t)
	if err := os.WriteFile(filepath.Join(r.dir, "manual.txt"), []byte("by hand\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(r.dir, "a.txt"), []byte("two, then edited by hand\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	two := turnChanges(t, r, second)
	if _, leaked := two["manual.txt"]; leaked || len(two) != 2 {
		t.Fatalf("the review of the second turn: %v", two)
	}
	// The turn is judged where it ended: a hand edit afterwards is not the agent's change, the file stays listed
	if got := two["a.txt"]; got != "modified:one\n>two, then edited by hand\n" {
		t.Fatalf("a.txt in the second turn: %q", got)
	}
	_ = first
}
