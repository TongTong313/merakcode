package engine_test

import (
	"context"
	"github.com/TongTong313/merakcode/merak/engine"
	"github.com/TongTong313/merakcode/merak/engine/event"
	"github.com/TongTong313/merakcode/merak/engine/group"
	"github.com/TongTong313/merakcode/merak/engine/model"
	"github.com/TongTong313/merakcode/merak/engine/model/fake"
	"github.com/TongTong313/merakcode/merak/engine/permission"
	"github.com/TongTong313/merakcode/merak/engine/profile"
	"github.com/TongTong313/merakcode/merak/engine/store"
	"github.com/TongTong313/merakcode/merak/engine/task"
	"github.com/TongTong313/merakcode/merak/engine/worker"
	"os"
	"path/filepath"
	"reflect"
	"testing"
	"time"
)

func TestGroupPermissionsNotifyQualifiedHumansAndRejectLowerRoles(t *testing.T) {
	for _, tc := range []struct {
		name, path, human string
		want              []event.ID
		allowed           bool
	}{
		{"ordinary write", "result.txt", "approver", []event.ID{"approver", "admin", "owner"}, true},
		{"protected write", "merakcode.json", "approver", []event.ID{"admin", "owner"}, false},
		{"higher role", "merakcode.json", "owner", []event.ID{"admin", "owner"}, true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
			defer cancel()
			dir := t.TempDir()
			provider := fake.New(t, integrationCall("write_file", map[string]any{"path": tc.path, "content": "verified"}), fake.Reply{Text: "Finished"})
			var e *engine.Engine
			asked := false
			var err error
			e, err = engine.New(engine.Deps{Workdir: dir, Providers: map[string]model.Provider{"fake": provider}, Ask: func(ctx context.Context, req permission.Request) (permission.Reply, error) {
				asked = true
				facts, err := e.FindEvents(ctx, store.Query{Scope: event.Scope{Group: req.Call.Env.Scope.Group}, Types: []event.Type{group.NoticeSent}})
				if err != nil || len(facts) != 1 {
					t.Errorf("notices=%d err=%v", len(facts), err)
				} else {
					notice, err := event.Decode[group.Notice](facts[0])
					if err != nil || notice.Kind != "permission" || !reflect.DeepEqual(notice.To, tc.want) || facts[0].Cause != req.ID {
						t.Errorf("notice=%+v cause=%s err=%v", notice, facts[0].Cause, err)
					}
				}
				return permission.Reply{Decision: permission.Allow, Human: event.ID(tc.human)}, nil
			}})
			if err != nil {
				t.Fatal(err)
			}
			defer e.Close()
			lead := profile.DefaultLeader()
			lead.ID, lead.Model.Provider = "leader-profile", "fake"
			p := profile.DefaultWorker()
			p.ID, p.Model.Provider = "worker-profile", "fake"
			g, err := e.CreateGroup(ctx, group.Group{Kind: group.KindLocal, Name: "Review", Project: group.Project{Directory: dir}, DefaultLeader: "leader"}, []group.Member{
				{ID: "leader", Name: "Leader", Kind: group.MemberAgent, AgentRole: group.AgentLeader, Profile: lead.ID},
				{ID: "worker", Name: "Worker", Kind: group.MemberAgent, AgentRole: group.AgentWorker, Profile: p.ID},
				{ID: "approver", Name: "Approver", Kind: group.MemberHuman, Role: group.RoleApprover},
				{ID: "admin", Name: "Admin", Kind: group.MemberHuman, Role: group.RoleAdmin},
				{ID: "owner", Name: "Owner", Kind: group.MemberHuman, Role: group.RoleOwner},
			}, []profile.Profile{lead, p})
			if err != nil {
				t.Fatal(err)
			}
			run, err := e.StartWorker(ctx, p, worker.Assignment{Session: event.NewID(), Scope: event.Scope{Group: g.ID}, Workdir: dir, Packet: "Write the result", Claim: task.Claim{ID: "claim", Member: "worker"}})
			if err != nil {
				t.Fatal(err)
			}
			if _, err := run.Wait(ctx); err != nil {
				t.Fatal(err)
			}
			if !asked {
				t.Fatal("approval was not requested")
			}
			_, err = os.Stat(filepath.Join(dir, tc.path))
			if (err == nil) != tc.allowed {
				t.Fatalf("write allowed=%v error=%v", tc.allowed, err)
			}
			facts, err := e.FindEvents(ctx, store.Query{Scope: event.Scope{Group: g.ID}, Types: []event.Type{permission.Replied}})
			if err != nil {
				t.Fatal(err)
			}
			mirrored := false
			for _, fact := range facts {
				if fact.Stream == event.Stream("group:"+g.ID) {
					mirrored = true
				}
			}
			if !mirrored {
				t.Fatal("the group inbox cannot replay the permission answer")
			}
		})
	}
}

func TestTaskReviewAndCompletionReachTheHumanInbox(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 8*time.Second)
	defer cancel()
	dir := t.TempDir()
	quiet := groupScript{name: "leader-model", test: t, reply: func(model.Request) fake.Reply { return fake.Reply{Text: "Recorded"} }}
	e, err := engine.New(engine.Deps{Workdir: dir, Providers: map[string]model.Provider{"leader-model": quiet, "worker-model": fake.New(t, integrationCall("submit_report", map[string]any{"verdict": "done", "summary": "Verified"}))}})
	if err != nil {
		t.Fatal(err)
	}
	defer e.Close()
	lead := profile.DefaultLeader()
	lead.ID, lead.Model.Provider = "lead-profile", "leader-model"
	p := profile.DefaultWorker()
	p.ID, p.Model.Provider = "worker-profile", "worker-model"
	g, err := e.CreateGroup(ctx, group.Group{Kind: group.KindLocal, Name: "Group", Project: group.Project{Directory: dir}, DefaultLeader: "leader"}, []group.Member{
		{ID: "leader", Name: "Leader", Kind: group.MemberAgent, AgentRole: group.AgentLeader, Profile: lead.ID},
		{ID: "worker", Name: "Worker", Kind: group.MemberAgent, AgentRole: group.AgentWorker, Profile: p.ID, Owner: "owner"},
		{ID: "viewer", Name: "Viewer", Kind: group.MemberHuman},
		{ID: "approver", Name: "Approver", Kind: group.MemberHuman, Role: group.RoleApprover},
		{ID: "owner", Name: "Owner", Kind: group.MemberHuman, Role: group.RoleOwner},
	}, []profile.Profile{lead, p})
	if err != nil {
		t.Fatal(err)
	}
	facts, stop := e.Bus.Subscribe(event.Filter{Scope: event.Scope{Group: g.ID}, Types: []event.Type{group.NoticeSent}})
	defer stop()
	card, err := e.CreateAssignedTask(ctx, task.Card{Group: g.ID, Title: "Review result", Workspace: "none", Review: true, CreatedBy: event.Actor{Kind: event.ActorHuman, ID: "owner"}}, "worker")
	if err != nil {
		t.Fatal(err)
	}
	wait := func(kind string, want []event.ID) {
		t.Helper()
		for {
			select {
			case fact := <-facts:
				notice, err := event.Decode[group.Notice](fact)
				if err != nil {
					t.Fatal(err)
				}
				if notice.Kind != kind {
					continue
				}
				if fact.Scope.Task != card.ID || !reflect.DeepEqual(notice.To, want) {
					t.Fatalf("notice=%+v scope=%+v", notice, fact.Scope)
				}
				return
			case <-ctx.Done():
				t.Fatal(ctx.Err())
			}
		}
	}
	wait("review", []event.ID{"approver", "owner"})
	enterGoalIntegration(t, ctx, e, card.ID)
	waitGoalPhase(t, ctx, e, card.ID, task.PhaseReview)
	if err := e.ReviewTask(ctx, card.ID, "viewer", "approve", ""); err == nil {
		t.Fatal("ordinary member approved the task")
	}
	if err := e.ReviewTask(ctx, card.ID, "owner", "approve", ""); err != nil {
		t.Fatal(err)
	}
	wait("info", []event.ID{"owner"})
}
