package engine_test

import (
	"context"
	"testing"
	"time"

	"github.com/TongTong313/merakcode/merak/engine"
	"github.com/TongTong313/merakcode/merak/engine/agent"
	"github.com/TongTong313/merakcode/merak/engine/event"
	"github.com/TongTong313/merakcode/merak/engine/group"
	"github.com/TongTong313/merakcode/merak/engine/loop"
	"github.com/TongTong313/merakcode/merak/engine/model"
	"github.com/TongTong313/merakcode/merak/engine/model/fake"
	"github.com/TongTong313/merakcode/merak/engine/task"
)

func TestGroupLimitKeepsReceiptsLiveAndSettingsWakePendingThread(t *testing.T) {
	ctx, cancel := context.WithTimeout(t.Context(), 8*time.Second)
	defer cancel()
	e, err := engine.New(engine.Deps{Workdir: t.TempDir(), Providers: map[string]model.Provider{"leader": groupScript{name: "leader", test: t, reply: func(model.Request) fake.Reply { return fake.Reply{Text: "Recorded"} }}}})
	if err != nil {
		t.Fatal(err)
	}
	defer e.Close()
	p := agent.DefaultLeader()
	p.ID, p.Model.Provider = "profile", "leader"
	one := 1
	settings := group.Settings{TurnsPerMinute: &group.TurnLimits{Thread: &one, Group: &one}}
	g, err := createGroup(t, e, ctx, group.Group{Kind: group.KindLocal, Name: "Limited", Leader: "leader", Project: group.Project{Directory: t.TempDir()}, Settings: settings}, []group.Member{{ID: "leader", Name: "Leader", Kind: group.MemberAgent, AgentRole: group.AgentLeader, Agent: p.ID}, {ID: "owner", Name: "Owner", Kind: group.MemberHuman, Role: group.RoleOwner}}, []agent.Agent{p})
	if err != nil {
		t.Fatal(err)
	}
	facts, stop := e.Bus.Subscribe(event.Filter{Scope: event.Scope{Group: g.ID}, Types: []event.Type{loop.TurnFinished, group.NoticeSent}})
	defer stop()
	card, err := e.CreateTask(ctx, task.Card{Group: g.ID, Title: "Limited task", CreatedBy: event.Actor{Kind: event.ActorHuman, ID: "owner"}})
	if err != nil {
		t.Fatal(err)
	}
	for {
		select {
		case fact := <-facts:
			if fact.Type == loop.TurnFinished {
				goto ready
			}
		case <-ctx.Done():
			t.Fatal(ctx.Err())
		}
	}
ready:
	if _, err := e.SayGroup(ctx, g.ID, card.ID, "owner", group.Message{Text: "Continue pending work", To: []event.ID{"leader"}}); err != nil {
		t.Fatal(err)
	}
	receipt := false
	timer := time.NewTimer(50 * time.Millisecond)
	defer timer.Stop()
	for {
		select {
		case fact := <-facts:
			if fact.Type == loop.TurnFinished {
				t.Fatal("thread exceeded its limit")
			}
			receipt = true
		case <-timer.C:
			goto update
		case <-ctx.Done():
			t.Fatal(ctx.Err())
		}
	}
update:
	if !receipt {
		t.Fatal("limit blocked the receipt")
	}
	two := 2
	settings.TurnsPerMinute = &group.TurnLimits{Thread: &two, Group: &two}
	if _, err := e.UpdateGroup(ctx, g.ID, "owner", group.Update{Settings: &settings}); err != nil {
		t.Fatal(err)
	}
	for {
		select {
		case fact := <-facts:
			if fact.Type == loop.TurnFinished {
				return
			}
		case <-ctx.Done():
			t.Fatal("updated limits did not wake pending input")
		}
	}
}
