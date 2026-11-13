package engine_test

import (
	"context"
	"encoding/json"
	"strings"
	"testing"
	"time"

	"github.com/TongTong313/merakcode/merak/engine"
	"github.com/TongTong313/merakcode/merak/engine/agent"
	"github.com/TongTong313/merakcode/merak/engine/event"
	"github.com/TongTong313/merakcode/merak/engine/group"
	"github.com/TongTong313/merakcode/merak/engine/loop"
	"github.com/TongTong313/merakcode/merak/engine/model"
	"github.com/TongTong313/merakcode/merak/engine/model/fake"
	"github.com/TongTong313/merakcode/merak/engine/store/memory"
)

// A group has no pause control for people: only a Leader that keeps failing halts its group (MRK-4004), and the next
// thing a person writes in the group wakes it again.
func TestAGroupWhoseLeaderFailedStaysHaltedAcrossRestartsAndWakesWhenAPersonWrites(t *testing.T) {
	ctx, cancel := context.WithTimeout(t.Context(), 20*time.Second)
	defer cancel()
	dir, disk := t.TempDir(), memory.New()
	e, err := engine.New(engine.Deps{Store: disk, Workdir: dir})
	if err != nil {
		t.Fatal(err)
	}
	defer e.Close()
	p := agent.DefaultMerakCode()
	p.ID, p.Model.Provider = "lp", "fake"
	g, err := createGroup(t, e, ctx, group.Group{Kind: group.KindLocal, Name: "Halted", Leader: "leader", Project: group.Project{Directory: dir}}, []group.Member{
		{ID: "owner", Name: "Owner", Kind: group.MemberHuman, Role: group.RoleOwner},
		{ID: "leader", Name: "Leader", Kind: group.MemberAgent, AgentRole: group.AgentLeader, Agent: p.ID},
	}, []agent.Agent{p})
	if err != nil {
		t.Fatal(err)
	}
	halt, _ := json.Marshal(group.Control{Thread: g.ID, Code: "MRK-4004"})
	if _, err := e.Bus.Publish(ctx, event.Event{Stream: event.Stream("group:" + g.ID), Scope: event.Scope{Group: g.ID}, Type: group.Paused, Actor: event.Actor{Kind: event.ActorAgent, ID: "leader"}, Payload: halt}); err != nil {
		t.Fatal(err)
	}
	e.Close()

	seen := make(chan string, 4)
	provider := groupScript{name: "fake", test: t, reply: func(req model.Request) fake.Reply {
		body, _ := json.Marshal(req.Messages)
		seen <- string(body)
		return fake.Reply{Text: "Received"}
	}}
	open := func() *engine.Engine {
		next, err := engine.New(engine.Deps{Store: disk, Workdir: dir, Providers: map[string]model.Provider{"fake": provider}})
		if err != nil {
			t.Fatal(err)
		}
		if err := next.Recover(ctx); err != nil {
			t.Fatal(err)
		}
		return next
	}
	next := open()
	defer next.Close()
	state, err := next.Groups.Get(ctx, g.ID)
	if err != nil || !state.IsPaused(g.ID) {
		t.Fatalf("the halt was not kept across the restart: %v", err)
	}
	select {
	case <-seen:
		t.Fatal("a halted group invoked its Leader")
	case <-time.After(500 * time.Millisecond):
	}

	resumed, stopResumed := next.Bus.Subscribe(event.Filter{Scope: event.Scope{Group: g.ID}, Types: []event.Type{group.Resumed}})
	defer stopResumed()
	finished, stop := next.Bus.Subscribe(event.Filter{Scope: event.Scope{Group: g.ID}, Types: []event.Type{loop.TurnFinished}})
	defer stop()
	if _, err := next.SayGroup(ctx, g.ID, "", "owner", group.Message{Text: "Wake the group"}); err != nil {
		t.Fatal(err)
	}
	select {
	case <-resumed:
	case <-ctx.Done():
		t.Fatal("a person's message did not wake the halted group")
	}
	select {
	case text := <-seen:
		if !strings.Contains(text, "Wake the group") {
			t.Fatalf("the Leader did not get the message: %s", text)
		}
	case <-ctx.Done():
		t.Fatal("the woken group never ran its Leader")
	}
	select {
	case <-finished:
	case <-ctx.Done():
		t.Fatal(ctx.Err())
	}
	if state, err := next.Groups.Get(ctx, g.ID); err != nil || state.IsPaused(g.ID) {
		t.Fatalf("the group is still halted: %v", err)
	}
	next.Close()
	for len(seen) > 0 {
		<-seen
	}

	last := open()
	defer last.Close()
	if _, err := last.SayGroup(ctx, g.ID, "", "owner", group.Message{Text: "After the restart"}); err != nil {
		t.Fatal(err)
	}
	select {
	case text := <-seen:
		if strings.Count(text, "Wake the group") != 1 {
			t.Fatalf("redelivered a completed batch: %s", text)
		}
	case <-ctx.Done():
		t.Fatal(ctx.Err())
	}
}
