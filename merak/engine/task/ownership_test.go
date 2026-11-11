package task_test

import (
	"context"
	"testing"
	"time"

	"github.com/TongTong313/merakcode/merak/engine/event"
	"github.com/TongTong313/merakcode/merak/engine/group"
	"github.com/TongTong313/merakcode/merak/engine/store/memory"
	"github.com/TongTong313/merakcode/merak/engine/task"
)

func TestARestartKeepsTheGroupOfATaskEvenWhenEveryEventHasTheSameTime(t *testing.T) {
	ctx := context.Background()
	storage := memory.New()
	frozen := time.Date(2026, 11, 11, 12, 0, 0, 0, time.UTC)
	bus := event.NewBus(storage, func() time.Time { return frozen }, event.NewID)
	groups := group.New(storage, bus, event.NewID)
	directory := t.TempDir()
	g, err := groups.Create(ctx, group.Group{Kind: group.KindLocal, Name: "Project", Project: group.Project{Directory: directory}, Leader: "leader"}, []group.Member{
		{ID: "leader", Name: "Leader", Kind: group.MemberAgent, AgentRole: group.AgentLeader},
		{ID: "owner", Name: "Owner", Kind: group.MemberHuman, Role: group.RoleOwner},
	})
	if err != nil {
		t.Fatal(err)
	}
	pool := task.New(storage, bus, event.NewID, groups)
	card, err := pool.Create(ctx, task.Card{Title: "Alone", Project: directory, CreatedBy: event.Actor{Kind: event.ActorHuman, ID: "owner"}})
	if err != nil {
		t.Fatal(err)
	}
	if err := pool.Open(ctx, card.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Bind(ctx, card.ID, g.ID, "folder", "", event.Actor{Kind: event.ActorHuman, ID: "owner"}); err != nil {
		t.Fatal(err)
	}
	restarted := task.New(storage, event.NewBus(storage, time.Now, event.NewID), event.NewID, groups)
	got, err := restarted.Get(ctx, card.ID)
	if err != nil || got.Group != g.ID || got.Status != task.Open || got.Project != directory {
		t.Fatalf("after the restart: group=%q status=%s project=%q err=%v", got.Group, got.Status, got.Project, err)
	}
}
