package memory_test

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/TongTong313/merakcode/merak/engine/memory"
	storage "github.com/TongTong313/merakcode/merak/engine/store/memory"
)

func TestRememberImmediatelyRecallsRelevantNotesWithinTheirOwners(t *testing.T) {
	ctx := context.Background()
	durable := storage.New()
	repo := memory.New(durable)
	owner := memory.Owner{Scope: memory.ScopeProject, ID: "project-a"}
	for _, note := range []memory.Note{
		{ID: "old", Scope: owner.Scope, Owner: owner.ID, Kind: "pitfall", Text: "Run package checks", Tags: []string{"merak/engine.go"}, Created: time.Unix(1, 0)},
		{ID: "new", Scope: owner.Scope, Owner: owner.ID, Kind: "fact", Text: "Package checks run with Go", Created: time.Unix(3, 0)},
		{ID: "other", Scope: owner.Scope, Owner: "project-b", Kind: "fact", Text: "Run package checks", Tags: []string{"merak/engine.go"}},
		{ID: "unrelated", Scope: owner.Scope, Owner: owner.ID, Kind: "fact", Text: "The release uses a signing key"},
	} {
		if _, err := repo.Remember(ctx, note); err != nil {
			t.Fatal(err)
		}
	}
	notes, err := repo.Recall(ctx, memory.Query{Owners: []memory.Owner{owner}, Text: "package checks", Tags: []string{"merak/engine.go"}, Limit: 2})
	if err != nil || len(notes) != 2 || notes[0].ID != "old" || notes[1].ID != "new" {
		t.Fatalf("notes=%+v error=%v", notes, err)
	}
	// A new repository object reads the same stored notes.
	notes, err = memory.New(durable).Recall(ctx, memory.Query{Owners: []memory.Owner{owner}, Tags: []string{"merak/engine.go"}})
	if err != nil || len(notes) != 1 || notes[0].ID != "old" {
		t.Fatalf("notes=%+v error=%v", notes, err)
	}
}

func TestSecretNotesNeverBecomeRecallable(t *testing.T) {
	for _, sample := range []string{
		"sk-ant-api03-" + strings.Repeat("a", 40),
		"sk-" + strings.Repeat("b", 32),
		"ghp_" + strings.Repeat("c", 36),
		"AKIA" + strings.Repeat("D", 16),
		"password = \"example-secret\"",
		"-----BEGIN PRIVATE KEY-----\nexample\n-----END PRIVATE KEY-----",
		"eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJleGFtcGxlIn0.exampleSignature",
	} {
		repo := memory.New(storage.New())
		owner := memory.Owner{Scope: memory.ScopeMember, ID: "member"}
		_, err := repo.Remember(context.Background(), memory.Note{Scope: owner.Scope, Owner: owner.ID, Kind: "fact", Text: "Credential: " + sample})
		if !errors.Is(err, memory.ErrSecret) {
			t.Fatalf("expected secret rejection, got %v", err)
		}
		notes, err := repo.Recall(context.Background(), memory.Query{Owners: []memory.Owner{owner}})
		if err != nil || len(notes) != 0 {
			t.Fatalf("secret note persisted: count=%d error=%v", len(notes), err)
		}
	}
}
