package task_test

import (
	"context"
	"slices"
	"sync/atomic"
	"testing"
	"time"

	"github.com/TongTong313/merakcode/merak/engine/collab/group"
	"github.com/TongTong313/merakcode/merak/engine/collab/task"
	"github.com/TongTong313/merakcode/merak/engine/infra/event"
	"github.com/TongTong313/merakcode/merak/engine/infra/store"
	"github.com/TongTong313/merakcode/merak/storage/memory"
)

func TestFinishedTasksAreArchivedAutomaticallyAfterTheConfiguredDays(t *testing.T) {
	ctx, cancel := context.WithTimeout(t.Context(), 15*time.Second)
	defer cancel()
	directory := t.TempDir()
	var skew atomic.Int64
	now := func() time.Time { return time.Now().Add(time.Duration(skew.Load())) }
	advance := func(by time.Duration) { skew.Add(int64(by)) }
	storage := memory.New()
	bus := event.NewBus(storage, now, event.NewID)
	groups := group.New(storage, bus, event.NewID)
	pool := task.New(storage, bus, event.NewID, groups)
	board := task.NewBoard(pool, groups, now)
	actor := event.Actor{Kind: event.ActorHuman, ID: "human"}
	loose := func(title string) task.Card {
		t.Helper()
		card, err := pool.Create(ctx, task.Card{Title: title, Description: "Describe " + title, Project: directory, CreatedBy: actor})
		if err != nil {
			t.Fatal(err)
		}
		if err := pool.Open(ctx, card.ID); err != nil {
			t.Fatal(err)
		}
		card, err = pool.Get(ctx, card.ID)
		if err != nil {
			t.Fatal(err)
		}
		return card
	}
	card := loose("Old news")
	if err := pool.SetPhase(ctx, card.ID, task.PhaseCancelled, actor); err != nil {
		t.Fatal(err)
	}
	card, err := pool.Get(ctx, card.ID)
	if err != nil {
		t.Fatal(err)
	}
	live := loose("Live")
	archivedIDs := func() []event.ID {
		listed, err := pool.Find(ctx, task.Filter{Archived: true})
		if err != nil {
			t.Fatal(err)
		}
		result := []event.ID{}
		for _, card := range listed {
			result = append(result, card.ID)
		}
		slices.Sort(result)
		return result
	}
	advance(2*24*time.Hour + 23*time.Hour)
	if err := board.ArchiveStale(ctx); err != nil || len(archivedIDs()) != 0 {
		t.Fatalf("before the third day: %v err=%v", archivedIDs(), err)
	}
	board.Configure(7)
	advance(2 * time.Hour)
	if err := board.ArchiveStale(ctx); err != nil || len(archivedIDs()) != 0 {
		t.Fatalf("with 7 days configured: %v err=%v", archivedIDs(), err)
	}
	board.Configure(0)
	advance(30 * 24 * time.Hour)
	if err := board.ArchiveStale(ctx); err != nil || len(archivedIDs()) != 0 {
		t.Fatalf("with auto-archive off: %v err=%v", archivedIDs(), err)
	}
	board.Configure(3)
	if err := board.ArchiveStale(ctx); err != nil || !slices.Equal(archivedIDs(), []event.ID{card.ID}) {
		t.Fatalf("after 3 days: %v err=%v (the live task %s must stay)", archivedIDs(), err, live.ID)
	}
	facts, _ := storage.Find(ctx, store.Query{Types: []event.Type{task.ArchivedEvent}})
	if len(facts) != 1 || facts[0].Actor.Kind != event.ActorSystem {
		t.Fatalf("the actor of the archive: %+v", facts)
	}
}
