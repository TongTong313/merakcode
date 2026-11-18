package sandbox_test

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/TongTong313/merakcode/merak/engine"
	"github.com/TongTong313/merakcode/merak/engine/collab/group"
	"github.com/TongTong313/merakcode/merak/engine/infra/errorcode"
	"github.com/TongTong313/merakcode/merak/engine/infra/event"
	"github.com/TongTong313/merakcode/merak/engine/infra/store"
	memorystore "github.com/TongTong313/merakcode/merak/storage/memory"
	"github.com/TongTong313/merakcode/merak/testkit/enginetest"
)

func TestAnArchivedGroupIsReadOnlyAndSayingInItIsRefusedWithItsCode(t *testing.T) {
	dir := t.TempDir()
	deps := enginetest.Deps(t)
	deps.Workdir = dir
	e, err := engine.New(deps)
	if err != nil {
		t.Fatal(err)
	}
	defer e.Close()
	members := []group.Member{
		{ID: "human", Name: "Owner", Kind: group.MemberHuman, Role: group.RoleOwner},
		{ID: "leader", Name: "Leader", Kind: group.MemberAgent, AgentRole: group.AgentLeader, Agent: "builtin-merakcode", Owner: "human"},
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
			if _, err := e.CreateGroup(ctx, group.Group{ID: id, Kind: group.KindLocal, Name: "Old", Project: group.Project{Directory: dir}, Leader: "leader", Archived: test.archived}, members); err != nil {
				t.Fatal(err)
			}
			_, err := e.SayGroup(ctx, id, "", "human", group.Message{Text: "continue"})
			var coded *errorcode.Error
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
	deps2 := enginetest.Deps(t)
	deps2.Workdir = dir
	deps2.Store = storage
	first, err := engine.New(deps2)
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(t.Context(), 10*time.Second)
	defer cancel()
	members := []group.Member{
		{ID: "human", Name: "Owner", Kind: group.MemberHuman, Role: group.RoleOwner},
		{ID: "leader", Name: "Leader", Kind: group.MemberAgent, AgentRole: group.AgentLeader, Agent: "builtin-merakcode", Owner: "human"},
	}
	id := event.ID("old-group")
	if _, err := first.CreateGroup(ctx, group.Group{ID: id, Kind: group.KindLocal, Name: "Old", Project: group.Project{Directory: dir}, Leader: "leader", Archived: true}, members); err != nil {
		t.Fatal(err)
	}
	say := event.Event{Stream: event.Stream("group:" + id), Scope: event.Scope{Group: id}, Type: group.HumanSaid, Actor: event.Actor{Kind: event.ActorHuman, ID: "human"}, Payload: []byte(`{"text":"an old question"}`)}
	if _, err := first.Publish(ctx, say); err != nil {
		t.Fatal(err)
	}
	if err := first.Close(); err != nil {
		t.Fatal(err)
	}
	deps3 := enginetest.Deps(t)
	deps3.Workdir = dir
	deps3.Store = storage
	second, err := engine.New(deps3)
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
