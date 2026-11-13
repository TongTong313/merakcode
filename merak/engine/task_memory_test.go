package engine_test

import (
	"context"
	"encoding/json"
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
	"github.com/TongTong313/merakcode/merak/engine/model/fake"
	"github.com/TongTong313/merakcode/merak/engine/permission"
	storememory "github.com/TongTong313/merakcode/merak/engine/store/memory"
	"github.com/TongTong313/merakcode/merak/engine/task"
	"github.com/TongTong313/merakcode/merak/engine/worker"
	"github.com/TongTong313/merakcode/merak/internal/platform/process"
)

func TestClosingTaskExtractsReportAndDiscussionIntoConfiguredMemoryScope(t *testing.T) {
	for _, restart := range []bool{false, true} {
		t.Run(map[bool]string{false: "live", true: "restart"}[restart], func(t *testing.T) { testTaskMemory(t, restart, "") })
	}
}

func TestClosingExternalTaskExtractsMemoryWithItsLeaderModel(t *testing.T) {
	binary := filepath.Join(t.TempDir(), "command.exe")
	if out, err := process.Command(t.Context(), "", "go", "build", "-o", binary, "./worker/command/testdata/fakecommand").CombinedOutput(); err != nil {
		t.Fatalf("build: %s %v", out, err)
	}
	testTaskMemory(t, false, binary)
}

func testTaskMemory(t *testing.T, restart bool, binary string) {
	ctx, cancel := context.WithTimeout(t.Context(), 8*time.Second)
	defer cancel()
	dir, storage := t.TempDir(), storememory.New()
	provider := groupScript{name: "fixture", test: t, reply: func(req model.Request) fake.Reply {
		if strings.Contains(req.System, "Extract durable") {
			body, _ := json.Marshal(req.Messages)
			summary := "Verified the module check"
			if binary != "" {
				summary = "Inspected"
			}
			for _, want := range []string{summary, "Use the module directory"} {
				if !strings.Contains(string(body), want) {
					t.Errorf("extraction omitted %s", want)
				}
			}
			return fake.Reply{Text: `[{"kind":"pitfall","text":"Run checks in the module directory.","tags":["checks"]}]`}
		}
		for _, spec := range req.Tools {
			if spec.Name == "submit_report" {
				return integrationCall("submit_report", map[string]any{"verdict": "done", "summary": "Verified the module check"})
			}
		}
		return fake.Reply{Text: "Recorded"}
	}}
	e, err := engine.New(engine.Deps{Store: storage, Workdir: dir, Providers: map[string]model.Provider{"fixture": provider}})
	if err != nil {
		t.Fatal(err)
	}
	defer e.Close()
	lead, work := agent.DefaultMerakCode(), agent.DefaultMerakCode()
	lead.ID, lead.Model.Provider, work.ID, work.Model.Provider = "lead", "fixture", "work", "fixture"
	if binary != "" {
		work.Model = agent.ModelRef{}
		work.Mode = permission.ModeTakeover
		work.Product = &agent.Product{Kind: worker.KindCommand, Binary: binary}
	}
	if err := json.Unmarshal([]byte(`{"memory":["group"]}`), &work); err != nil {
		t.Fatal(err)
	}
	g, err := createGroup(t, e, ctx, group.Group{Kind: group.KindLocal, Name: "Memory", Project: group.Project{Directory: dir}, Leader: "leader"}, []group.Member{
		{ID: "owner", Name: "Owner", Kind: group.MemberHuman, Role: group.RoleOwner},
		{ID: "leader", Name: "Leader", Kind: group.MemberAgent, AgentRole: group.AgentLeader, Agent: lead.ID},
		{ID: "worker", Name: "Worker", Kind: group.MemberAgent, AgentRole: group.AgentWorker, Agent: work.ID},
	}, []agent.Agent{lead, work})
	if err != nil {
		t.Fatal(err)
	}
	root, err := e.CreateTask(ctx, task.Card{Group: g.ID, Title: "Build module", Workspace: "none"})
	if err != nil {
		t.Fatal(err)
	}
	workspaceKind := "none"
	if binary != "" {
		workspaceKind = "inplace"
	}
	card, err := e.CreateTask(ctx, task.Card{Group: g.ID, Parent: root.ID, Title: "Check module", Workspace: workspaceKind})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := e.SayGroup(ctx, g.ID, card.ID, "owner", group.Message{Text: "Use the module directory"}); err != nil {
		t.Fatal(err)
	}
	reports, stopReports := e.Bus.Subscribe(event.Filter{Scope: event.Scope{Task: card.ID}, Types: []event.Type{task.Reported}})
	defer stopReports()
	_, err = e.AssignTask(ctx, card.ID, "owner", "worker", task.RoleOwner, nil)
	if err != nil {
		t.Fatal(err)
	}
	select {
	case <-reports:
	case <-ctx.Done():
		t.Fatal(ctx.Err())
	}
	if restart {
		e.Close()
		e, err = engine.New(engine.Deps{Store: storage, Workdir: dir, Providers: map[string]model.Provider{"fixture": provider}})
		if err != nil {
			t.Fatal(err)
		}
		defer e.Close()
	}
	events, stop := e.Bus.Subscribe(event.Filter{Scope: event.Scope{Task: card.ID}, Types: []event.Type{memory.Extracted}})
	defer stop()
	if err := e.Tasks.Close(ctx, card.ID, task.Done); err != nil {
		t.Fatal(err)
	}
	if restart {
		if err := e.Recover(ctx); err != nil {
			t.Fatal(err)
		}
	}
	select {
	case fact := <-events:
		result, err := event.Decode[memory.Extraction](fact)
		if err != nil || result.Failed || result.Stored != 1 {
			t.Fatalf("extraction=%+v error=%v", result, err)
		}
	case <-ctx.Done():
		t.Fatal("closed task did not extract memory")
	}
	for _, owner := range []memory.Owner{{Scope: memory.ScopeGroup, ID: g.ID}, memory.ProjectOwner(dir), {Scope: memory.ScopeMember, ID: "worker"}} {
		notes, err := memory.New(storage).Recall(ctx, memory.Query{Owners: []memory.Owner{owner}})
		if err != nil {
			t.Fatal(err)
		}
		if owner.Scope == memory.ScopeGroup {
			if len(notes) != 1 || notes[0].Source != card.ID {
				t.Fatalf("task notes=%+v", notes)
			}
		} else if len(notes) != 0 {
			t.Fatalf("wrote outside configured scope: %+v", notes)
		}
	}
}
