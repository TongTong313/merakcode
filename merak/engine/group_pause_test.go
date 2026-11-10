package engine_test

import (
	"context"
	"encoding/json"
	"strings"
	"testing"
	"time"

	"github.com/TongTong313/merakcode/merak/engine"
	"github.com/TongTong313/merakcode/merak/engine/event"
	"github.com/TongTong313/merakcode/merak/engine/group"
	"github.com/TongTong313/merakcode/merak/engine/loop"
	"github.com/TongTong313/merakcode/merak/engine/model"
	"github.com/TongTong313/merakcode/merak/engine/model/fake"
	"github.com/TongTong313/merakcode/merak/engine/profile"
	"github.com/TongTong313/merakcode/merak/engine/store/memory"
	"github.com/TongTong313/merakcode/merak/engine/task"
)

func TestGroupPauseReachesAnActiveWorker(t *testing.T) {
	ctx, cancel := context.WithTimeout(t.Context(), 8*time.Second)
	defer cancel()
	started, paused := make(chan struct{}), make(chan struct{}, 1)
	worker := groupScript{name: "worker", test: t, reply: func(req model.Request) fake.Reply {
		body, _ := json.Marshal(req.Messages)
		if strings.Contains(string(body), "Pause requested") {
			select {
			case paused <- struct{}{}:
			default:
			}
			return fake.Reply{Text: `{"verdict":"blocked","summary":"Paused by owner"}`}
		}
		select {
		case <-started:
		default:
			close(started)
		}
		return fake.Reply{Hold: make(chan struct{})}
	}}
	leader := groupScript{name: "leader", test: t, reply: func(model.Request) fake.Reply { return fake.Reply{Text: "Recorded"} }}
	dir := t.TempDir()
	e, err := engine.New(engine.Deps{Workdir: dir, Providers: map[string]model.Provider{"worker": worker, "leader": leader}})
	if err != nil {
		t.Fatal(err)
	}
	defer e.Close()
	lp, wp := profile.DefaultLeader(), profile.DefaultWorker()
	lp.ID, lp.Model.Provider, wp.ID, wp.Model.Provider = "lp", "leader", "wp", "worker"
	g, err := e.CreateGroup(ctx, group.Group{Kind: group.KindLocal, Name: "Pause", Project: group.Project{Directory: dir}, DefaultLeader: "leader"}, []group.Member{
		{ID: "owner", Name: "Owner", Kind: group.MemberHuman, Role: group.RoleOwner},
		{ID: "leader", Name: "Leader", Kind: group.MemberAgent, AgentRole: group.AgentLeader, Profile: lp.ID},
		{ID: "worker", Name: "Worker", Kind: group.MemberAgent, AgentRole: group.AgentWorker, Profile: wp.ID},
	}, []profile.Profile{lp, wp})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := e.CreateAssignedTask(ctx, task.Card{Group: g.ID, Title: "Work", Workspace: "none", CreatedBy: event.Actor{Kind: event.ActorHuman, ID: "owner"}}, "worker"); err != nil {
		t.Fatal(err)
	}
	select {
	case <-started:
	case <-ctx.Done():
		t.Fatal(ctx.Err())
	}
	if err := e.SetGroupPaused(ctx, g.ID, "owner", "", true); err != nil {
		t.Fatal(err)
	}
	select {
	case <-paused:
	case <-ctx.Done():
		t.Fatal("active worker did not receive pause")
	}
}

func TestPausedGroupRetainsMessagesAcrossRestart(t *testing.T) {
	ctx, cancel := context.WithTimeout(t.Context(), 6*time.Second)
	defer cancel()
	dir, disk := t.TempDir(), memory.New()
	e, err := engine.New(engine.Deps{Store: disk, Workdir: dir})
	if err != nil {
		t.Fatal(err)
	}
	defer e.Close()
	p := profile.DefaultLeader()
	p.ID, p.Model.Provider = "lp", "fake"
	g, err := e.CreateGroup(ctx, group.Group{Kind: group.KindLocal, Name: "Paused", DefaultLeader: "leader", Project: group.Project{Directory: dir}}, []group.Member{
		{ID: "owner", Name: "Owner", Kind: group.MemberHuman, Role: group.RoleOwner},
		{ID: "leader", Name: "Leader", Kind: group.MemberAgent, AgentRole: group.AgentLeader, Profile: p.ID},
	}, []profile.Profile{p})
	if err != nil {
		t.Fatal(err)
	}
	if err := e.SetGroupPaused(ctx, g.ID, "owner", "", true); err != nil {
		t.Fatal(err)
	}
	for _, text := range []string{"First pending message", "Second pending message"} {
		if _, err := e.SayGroup(ctx, g.ID, "", "owner", group.Message{Text: text}); err != nil {
			t.Fatal(err)
		}
	}
	e.Close()
	seen := make(chan string, 4)
	provider := groupScript{name: "fake", test: t, reply: func(req model.Request) fake.Reply {
		body, _ := json.Marshal(req.Messages)
		seen <- string(body)
		return fake.Reply{Text: "Received"}
	}}
	next, err := engine.New(engine.Deps{Store: disk, Workdir: dir, Providers: map[string]model.Provider{"fake": provider}})
	if err != nil {
		t.Fatal(err)
	}
	defer next.Close()
	if err := next.Recover(ctx); err != nil {
		t.Fatal(err)
	}
	select {
	case <-seen:
		t.Fatal("paused group invoked its leader")
	default:
	}
	if err := next.SetGroupPaused(ctx, g.ID, "owner", "", false); err != nil {
		t.Fatal(err)
	}
	select {
	case text := <-seen:
		if !strings.Contains(text, "First pending message") || !strings.Contains(text, "Second pending message") {
			t.Fatalf("lost pending messages: %s", text)
		}
	case <-ctx.Done():
		t.Fatal("resumed group lost its pending messages")
	}
	finished, stop := next.Bus.Subscribe(event.Filter{Scope: event.Scope{Group: g.ID}, Types: []event.Type{loop.TurnFinished}})
	defer stop()
	if _, err := next.SayGroup(ctx, g.ID, "", "owner", group.Message{Text: "Finish before restart"}); err != nil {
		t.Fatal(err)
	}
	select {
	case <-finished:
	case <-ctx.Done():
		t.Fatal(ctx.Err())
	}
	next.Close()
	for len(seen) > 0 {
		<-seen
	}
	last, err := engine.New(engine.Deps{Store: disk, Workdir: dir, Providers: map[string]model.Provider{"fake": provider}})
	if err != nil {
		t.Fatal(err)
	}
	defer last.Close()
	if err := last.Recover(ctx); err != nil {
		t.Fatal(err)
	}
	if _, err := last.SayGroup(ctx, g.ID, "", "owner", group.Message{Text: "After second restart"}); err != nil {
		t.Fatal(err)
	}
	select {
	case text := <-seen:
		if strings.Count(text, "First pending message") != 1 || strings.Count(text, "Second pending message") != 1 {
			t.Fatalf("redelivered completed batch: %s", text)
		}
	case <-ctx.Done():
		t.Fatal(ctx.Err())
	}
}
