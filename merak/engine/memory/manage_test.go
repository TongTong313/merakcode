package memory_test

import (
	"context"
	"errors"
	"testing"

	"github.com/TongTong313/merakcode/merak/engine/memory"
	"github.com/TongTong313/merakcode/merak/engine/store"
	storage "github.com/TongTong313/merakcode/merak/engine/store/memory"
)

func TestNotesAreListedReadAndDeletedByTheirId(t *testing.T) {
	ctx := context.Background()
	repo := memory.New(storage.New())
	project, other := memory.ProjectOwner(t.TempDir()), memory.ProjectOwner(t.TempDir())
	first, err := repo.Remember(ctx, memory.Note{Scope: project.Scope, Owner: project.ID, Kind: "fact", Text: "First note"})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := repo.Remember(ctx, memory.Note{Scope: project.Scope, Owner: project.ID, Kind: "pitfall", Text: "Second note"}); err != nil {
		t.Fatal(err)
	}
	if _, err := repo.Remember(ctx, memory.Note{Scope: other.Scope, Owner: other.ID, Kind: "fact", Text: "Elsewhere"}); err != nil {
		t.Fatal(err)
	}
	if _, err := repo.Remember(ctx, memory.Note{Scope: memory.ScopeMember, Owner: "member-1", Kind: "preference", Text: "Mine"}); err != nil {
		t.Fatal(err)
	}

	listed, err := repo.List(ctx, []memory.Owner{project})
	if err != nil || len(listed) != 2 {
		t.Fatalf("listed=%+v err=%v", listed, err)
	}
	all, err := repo.List(ctx, nil)
	if err != nil || len(all) != 4 {
		t.Fatalf("every note: %d err=%v", len(all), err)
	}
	got, err := repo.Read(ctx, first.ID)
	if err != nil || got.Text != "First note" {
		t.Fatalf("got=%+v err=%v", got, err)
	}
	if err := repo.Delete(ctx, first.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := repo.Read(ctx, first.ID); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("a deleted note is still there: %v", err)
	}
	if listed, _ = repo.List(ctx, []memory.Owner{project}); len(listed) != 1 || listed[0].Text != "Second note" {
		t.Fatalf("after the delete: %+v", listed)
	}
	if err := repo.Delete(ctx, first.ID); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("deleting twice: %v", err)
	}
}
