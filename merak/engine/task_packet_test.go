package engine_test

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/TongTong313/merakcode/merak/engine"
	"github.com/TongTong313/merakcode/merak/engine/agent"
	"github.com/TongTong313/merakcode/merak/engine/event"
	"github.com/TongTong313/merakcode/merak/engine/group"
	"github.com/TongTong313/merakcode/merak/engine/memory"
	"github.com/TongTong313/merakcode/merak/engine/model"
	"github.com/TongTong313/merakcode/merak/engine/model/catalog"
	"github.com/TongTong313/merakcode/merak/engine/model/fake"
	storememory "github.com/TongTong313/merakcode/merak/engine/store/memory"
	"github.com/TongTong313/merakcode/merak/engine/task"
)

func TestClaimMaterialsIncludeGroupGoalDocumentsDependenciesAndBoundedDiscussion(t *testing.T) {
	ctx, cancel := context.WithTimeout(t.Context(), 12*time.Second)
	defer cancel()
	dir := t.TempDir()
	storage := storememory.New()
	if err := os.WriteFile(filepath.Join(dir, "README.md"), []byte("Fixture"), 0600); err != nil {
		t.Fatal(err)
	}
	seen := make(chan struct{}, 1)
	wp := groupScript{name: "worker", test: t, reply: func(req model.Request) fake.Reply {
		body, _ := json.Marshal(req.Messages)
		if strings.Contains(string(body), "Deliver feature") {
			if !strings.Contains(req.System, "Material group") {
				t.Error("group brief missing from system prompt")
			}
			for _, text := range []string{"Overall product goal", "Design contract", "Dependency evidence", "Recent instruction", "Remembered convention"} {
				if !strings.Contains(string(body), text) {
					t.Errorf("materials omit %s", text)
				}
			}
			if strings.Contains(string(body), "Old oversized instruction") {
				t.Error("old discussion exceeded its material budget")
			}
			seen <- struct{}{}
		}
		return integrationCall("submit_report", map[string]any{"verdict": "done", "summary": "Dependency evidence"})
	}}
	lp := groupScript{name: "leader", test: t, reply: func(model.Request) fake.Reply { return fake.Reply{Text: "Recorded"} }}
	e, err := engine.New(engine.Deps{Store: storage, Workdir: dir, Providers: map[string]model.Provider{"worker": wp, "leader": lp}})
	if err != nil {
		t.Fatal(err)
	}
	defer e.Close()
	e.ConfigureModels([]catalog.Override{{Provider: "worker", Window: new(32000)}})
	lead, work := agent.DefaultLeader(), agent.DefaultWorker()
	lead.ID, lead.Model.Provider, work.ID, work.Model.Provider = "lead", "leader", "work", "worker"
	g, err := createGroup(t, e, ctx, group.Group{Kind: group.KindLocal, Name: "Material group", Leader: "leader", Project: group.Project{Directory: dir}}, []group.Member{
		{ID: "owner", Name: "Owner", Kind: group.MemberHuman, Role: group.RoleOwner},
		{ID: "leader", Name: "Leader", Kind: group.MemberAgent, AgentRole: group.AgentLeader, Agent: lead.ID},
		{ID: "worker", Name: "Worker", Kind: group.MemberAgent, AgentRole: group.AgentWorker, Agent: work.ID},
	}, []agent.Agent{lead, work})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := e.WriteGroupDocument(ctx, event.Actor{Kind: event.ActorHuman, ID: "owner"}, group.Document{DocumentInfo: group.DocumentInfo{Group: g.ID, Key: "design", Title: "Design contract"}, Text: "Document body stays out of initial materials"}); err != nil {
		t.Fatal(err)
	}
	owner := memory.ProjectOwner(dir)
	if _, err := memory.New(storage).Remember(ctx, memory.Note{ID: "note", Scope: owner.Scope, Owner: owner.ID, Kind: "fact", Text: "Remembered convention"}); err != nil {
		t.Fatal(err)
	}
	root, err := e.CreateTask(ctx, task.Card{Group: g.ID, Title: "Overall product goal", Workspace: "none"})
	if err != nil {
		t.Fatal(err)
	}
	dep, err := e.CreateTask(ctx, task.Card{Group: g.ID, Parent: root.ID, Title: "Prepare dependency", Workspace: "none"})
	if err != nil {
		t.Fatal(err)
	}
	target, err := e.CreateTask(ctx, task.Card{Group: g.ID, Parent: root.ID, Title: "Deliver feature", Workspace: "none", Deps: []event.ID{dep.ID}})
	if err != nil {
		t.Fatal(err)
	}
	for _, text := range []string{"Old oversized instruction " + strings.Repeat("old", 40000), "Recent instruction"} {
		id, err := e.SayGroup(ctx, g.ID, target.ID, "owner", group.Message{Text: text})
		if err != nil {
			t.Fatal(err)
		}
		if err := e.Tasks.RecordDiscussion(ctx, target.ID, id); err != nil {
			t.Fatal(err)
		}
	}
	reports, stop := e.Bus.Subscribe(event.Filter{Scope: event.Scope{Group: g.ID, Task: dep.ID}, Types: []event.Type{task.Reported}})
	defer stop()
	if _, err := e.AssignTask(ctx, dep.ID, "owner", "worker", task.RoleOwner, nil); err != nil {
		t.Fatal(err)
	}
	select {
	case <-reports:
	case <-ctx.Done():
		t.Fatal(ctx.Err())
	}
	if err := e.Tasks.Close(ctx, dep.ID, task.Done); err != nil {
		t.Fatal(err)
	}
	if _, err := e.AssignTask(ctx, target.ID, "owner", "worker", task.RoleOwner, nil); err != nil {
		t.Fatal(err)
	}
	select {
	case <-seen:
	case <-ctx.Done():
		t.Fatal("worker never received materials")
	}
}
