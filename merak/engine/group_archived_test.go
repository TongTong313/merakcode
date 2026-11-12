package engine_test

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/TongTong313/merakcode/merak/engine"
	"github.com/TongTong313/merakcode/merak/engine/event"
	"github.com/TongTong313/merakcode/merak/engine/group"
	"github.com/TongTong313/merakcode/merak/engine/store"
	memorystore "github.com/TongTong313/merakcode/merak/engine/store/memory"
)

func TestAnArchivedGroupIsReadOnlyAndSayingInItIsRefusedWithItsCode(t *testing.T) {
	dir := t.TempDir()
	e, err := engine.New(engine.Deps{Workdir: dir})
	if err != nil {
		t.Fatal(err)
	}
	defer e.Close()
	members := []group.Member{
		{ID: "human", Name: "Owner", Kind: group.MemberHuman, Role: group.RoleOwner},
		{ID: "leader", Name: "Leader", Kind: group.MemberAgent, AgentRole: group.AgentLeader, Agent: "builtin-leader", Owner: "human"},
	}
	for _, test := range []struct {
		name     string
		archived bool
		wantCode string
	}{
		{"archived", true, "MRK-4020"},
		{"active", false, ""},
	} {
		t.Run(test.name, func(t *testing.T) {
			ctx, cancel := context.WithTimeout(t.Context(), 10*time.Second)
			defer cancel()
			id := event.ID("group-" + test.name)
			if _, err := e.Groups.Create(ctx, group.Group{ID: id, Kind: group.KindLocal, Name: "Old", Project: group.Project{Directory: dir}, Leader: "leader", Archived: test.archived}, members); err != nil {
				t.Fatal(err)
			}
			_, err := e.SayGroup(ctx, id, "", "human", group.Message{Text: "continue"})
			var coded *engine.Error
			switch {
			case test.wantCode == "" && err != nil && errors.As(err, &coded):
				t.Fatalf("an active group refused a message with %s", coded.Code)
			case test.wantCode == "":
			case !errors.As(err, &coded) || coded.Code != test.wantCode:
				t.Fatalf("err = %v, want code %s", err, test.wantCode)
			}
			facts, ferr := e.FindEvents(ctx, store.Query{Scope: event.Scope{Group: id}, Types: []event.Type{group.HumanSaid}})
			if ferr != nil {
				t.Fatal(ferr)
			}
			if (len(facts) == 0) != (test.wantCode != "") {
				t.Fatalf("recorded %d human messages for a group that is archived=%v", len(facts), test.archived)
			}
		})
	}
}

func TestRecoveringTheEngineLeavesAnArchivedGroupAloneAndItsHistoryReadable(t *testing.T) {
	dir := t.TempDir()
	storage := memorystore.New()
	first, err := engine.New(engine.Deps{Workdir: dir, Store: storage})
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(t.Context(), 10*time.Second)
	defer cancel()
	members := []group.Member{
		{ID: "human", Name: "Owner", Kind: group.MemberHuman, Role: group.RoleOwner},
		{ID: "leader", Name: "Leader", Kind: group.MemberAgent, AgentRole: group.AgentLeader, Agent: "builtin-leader", Owner: "human"},
	}
	id := event.ID("old-group")
	if _, err := first.Groups.Create(ctx, group.Group{ID: id, Kind: group.KindLocal, Name: "Old", Project: group.Project{Directory: dir}, Leader: "leader", Archived: true}, members); err != nil {
		t.Fatal(err)
	}
	say := event.Event{Stream: event.Stream("group:" + id), Scope: event.Scope{Group: id}, Type: group.HumanSaid, Actor: event.Actor{Kind: event.ActorHuman, ID: "human"}, Payload: []byte(`{"text":"an old question"}`)}
	if _, err := first.Bus.Publish(ctx, say); err != nil {
		t.Fatal(err)
	}
	if err := first.Close(); err != nil {
		t.Fatal(err)
	}
	second, err := engine.New(engine.Deps{Workdir: dir, Store: storage})
	if err != nil {
		t.Fatal(err)
	}
	defer second.Close()
	if err := second.Recover(ctx); err != nil {
		t.Fatal(err)
	}
	time.Sleep(300 * time.Millisecond)
	facts, err := second.ReadEvents(ctx, event.Stream("group:"+id), 1, 0)
	if err != nil || len(facts) != 2 {
		t.Fatalf("the group stream holds %d events after recovery (%v), want the creation and the old question only", len(facts), err)
	}
}
