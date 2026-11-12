package engine_test

import (
	"context"
	"sync/atomic"
	"testing"
	"time"

	"github.com/TongTong313/merakcode/merak/engine"
	"github.com/TongTong313/merakcode/merak/engine/agent"
	"github.com/TongTong313/merakcode/merak/engine/event"
	"github.com/TongTong313/merakcode/merak/engine/group"
	"github.com/TongTong313/merakcode/merak/engine/leader"
	"github.com/TongTong313/merakcode/merak/engine/loop"
	"github.com/TongTong313/merakcode/merak/engine/model"
	"github.com/TongTong313/merakcode/merak/engine/model/fake"
	"github.com/TongTong313/merakcode/merak/engine/store"
)

func TestStoppingALeaderTurnEndsTheTurnAndTheLeaderAnswersTheNextMessage(t *testing.T) {
	ctx, cancel := context.WithTimeout(t.Context(), 20*time.Second)
	defer cancel()
	var calls atomic.Int32
	held := make(chan struct{})
	started := make(chan struct{}, 4)
	provider := groupScript{name: "leader-model", test: t, reply: func(model.Request) fake.Reply {
		if calls.Add(1) == 1 {
			started <- struct{}{}
			return fake.Reply{Hold: held}
		}
		return fake.Reply{Text: "Back to work."}
	}}
	e, err := engine.New(engine.Deps{Workdir: t.TempDir(), Providers: map[string]model.Provider{"leader-model": provider}})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { e.Close() })
	lead := agent.DefaultLeader()
	lead.ID, lead.Model.Provider = "leader-agent", "leader-model"
	dir := t.TempDir()
	g, err := createGroup(t, e, ctx, group.Group{Kind: group.KindLocal, Name: "Team", Project: group.Project{Directory: dir}, Leader: "leader"}, []group.Member{
		{ID: "human", Name: "Owner", Kind: group.MemberHuman, Role: group.RoleOwner},
		{ID: "leader", Name: "Leader", Kind: group.MemberAgent, AgentRole: group.AgentLeader, Agent: lead.ID, Owner: "human"},
	}, []agent.Agent{lead})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := e.SayGroup(ctx, g.ID, "", "human", group.Message{Text: "Start thinking."}); err != nil {
		t.Fatal(err)
	}
	select {
	case <-started:
	case <-ctx.Done():
		t.Fatal("the Leader did not start")
	}
	var thread event.ID
	for thread == "" {
		facts, err := e.FindEvents(ctx, store.Query{Scope: event.Scope{Group: g.ID}, Types: []event.Type{leader.ThreadStarted}})
		if err != nil {
			t.Fatal(err)
		}
		if len(facts) > 0 {
			handover, _ := event.Decode[leader.Handover](facts[0])
			thread = handover.Session
		}
		time.Sleep(10 * time.Millisecond)
	}
	if err := e.Cancel(thread); err != nil {
		t.Fatalf("stopping the Leader turn: %v", err)
	}
	waitFor := func(what string, done func() bool) {
		t.Helper()
		for !done() {
			if ctx.Err() != nil {
				t.Fatalf("timed out waiting for %s", what)
			}
			time.Sleep(10 * time.Millisecond)
		}
	}
	finished := func() []event.Event {
		facts, _ := e.FindEvents(ctx, store.Query{Scope: event.Scope{Session: thread}, Types: []event.Type{loop.TurnFinished}})
		return facts
	}
	waitFor("the stopped turn to finish", func() bool { return len(finished()) == 1 })
	if outcome, _ := event.Decode[loop.Outcome](finished()[0]); outcome.Stop != loop.Cancelled {
		t.Fatalf("the turn ended with %q, want a cancelled turn", outcome.Stop)
	}
	time.Sleep(200 * time.Millisecond)
	if calls.Load() != 1 {
		t.Fatalf("the stopped input was sent to the model again (%d calls)", calls.Load())
	}
	if _, err := e.SayGroup(ctx, g.ID, "", "human", group.Message{Text: "Carry on."}); err != nil {
		t.Fatal(err)
	}
	waitFor("the next turn", func() bool { return len(finished()) == 2 })
	if err := e.Cancel("no-such-session"); err == nil {
		t.Fatal("stopping an unknown session succeeded")
	}
}
