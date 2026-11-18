package sandbox_test

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/TongTong313/merakcode/merak/engine"
	"github.com/TongTong313/merakcode/merak/engine/agent/definition"
	"github.com/TongTong313/merakcode/merak/engine/agent/memory"
	"github.com/TongTong313/merakcode/merak/engine/agent/model"
	"github.com/TongTong313/merakcode/merak/engine/agent/model/fake"
	"github.com/TongTong313/merakcode/merak/engine/agent/permission"
	"github.com/TongTong313/merakcode/merak/engine/collab/group"
	"github.com/TongTong313/merakcode/merak/engine/collab/task"
	"github.com/TongTong313/merakcode/merak/engine/collab/workspace"
	"github.com/TongTong313/merakcode/merak/engine/infra/event"
	"github.com/TongTong313/merakcode/merak/testkit/enginetest"
)

func TestGoalReviewRetainsChildFilesForReworkAndReleasesThemAfterDelivery(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 12*time.Second)
	defer cancel()
	dir := t.TempDir()
	quiet := enginetest.GroupScript{ProviderName: "leader-model", Test: t, Reply: func(model.Request) fake.Reply { return fake.Reply{Text: "Recorded"} }}
	workModel := fake.New(t,
		enginetest.IntegrationCall("write_file", map[string]any{"path": "draft.txt", "content": "First draft"}),
		enginetest.IntegrationCall("submit_report", map[string]any{"verdict": "done", "summary": "First report"}),
		enginetest.IntegrationCall("read_file", map[string]any{"path": "draft.txt"}),
		enginetest.IntegrationCall("submit_report", map[string]any{"verdict": "done", "summary": "Revised report"}),
	)
	deps := enginetest.Deps(t)
	deps.Workdir = dir
	deps.Providers = map[string]model.Provider{"leader-model": quiet, "worker-model": workModel}
	deps.Ask = func(context.Context, permission.Request) (permission.Reply, error) {
		return permission.Reply{Decision: permission.Allow, Human: "owner"}, nil
	}
	e, err := engine.New(deps)
	if err != nil {
		t.Fatal(err)
	}
	defer e.Close()
	lead := definition.DefaultMerakCode()
	lead.ID, lead.Model.Provider = "lead-profile", "leader-model"
	worker := definition.DefaultMerakCode()
	worker.Memory = []memory.Scope{}
	worker.ID, worker.Model.Provider = "worker-profile", "worker-model"
	g, err := enginetest.CreateGroup(t, e, ctx, group.Group{Kind: group.KindLocal, Name: "Group", Project: group.Project{Directory: dir}, Leader: "leader"}, []group.Member{
		{ID: "leader", Name: "Leader", Kind: group.MemberAgent, AgentRole: group.AgentLeader, Agent: lead.ID},
		{ID: "worker", Name: "Worker", Kind: group.MemberAgent, AgentRole: group.AgentWorker, Agent: worker.ID},
		{ID: "owner", Name: "Owner", Kind: group.MemberHuman, Role: group.RoleOwner},
	}, []definition.Agent{lead, worker})
	if err != nil {
		t.Fatal(err)
	}
	facts, stop := e.Subscribe(event.Filter{Scope: event.Scope{Group: g.ID}})
	defer stop()
	root, err := e.CreateTask(ctx, task.Card{Group: g.ID, Title: "Goal", Workspace: "folder"})
	if err != nil {
		t.Fatal(err)
	}
	actor := event.Actor{Kind: event.ActorAgent, ID: "leader"}
	if err := e.UpdateTask(ctx, root.ID, task.Update{Phase: task.PhaseDoing}, actor); err != nil {
		t.Fatal(err)
	}
	child, err := e.CreateTask(ctx, task.Card{Group: g.ID, Parent: root.ID, Title: "Draft", Workspace: "folder"})
	if err != nil {
		t.Fatal(err)
	}
	claim, err := e.AssignTask(ctx, child.ID, "owner", "worker", task.RoleOwner, nil)
	if err != nil {
		t.Fatal(err)
	}
	waitReport := func() {
		t.Helper()
		for {
			select {
			case fact := <-facts:
				if fact.Type == task.Reported && fact.Scope.Task == child.ID {
					return
				}
			case <-ctx.Done():
				t.Fatal(ctx.Err())
			}
		}
	}
	waitReview := func() {
		t.Helper()
		for {
			select {
			case fact := <-facts:
				if fact.Type == group.NoticeSent && fact.Scope.Task == root.ID {
					notice, _ := event.Decode[group.Notice](fact)
					if notice.Kind == "review" {
						return
					}
				}
			case <-ctx.Done():
				t.Fatal(ctx.Err())
			}
		}
	}
	waitReport()
	first, _ := e.Task(ctx, child.ID)
	if err := e.ReviewTask(ctx, child.ID, "owner", "approve", ""); err != nil {
		t.Fatal(err)
	}
	if err := e.UpdateTask(ctx, root.ID, task.Update{Phase: task.PhaseIntegrating}, actor); err != nil {
		t.Fatal(err)
	}
	waitReview()
	ws, err := e.Workspace(ctx, first.Claims[0].Workspace)
	if err != nil || ws.Released {
		t.Fatalf("child workspace was released before goal review: %+v %v", ws, err)
	}
	if err := e.ReviewTask(ctx, root.ID, "owner", "rework", "Check the original draft again"); err != nil {
		t.Fatal(err)
	}
	waitReport()
	revised, _ := e.Task(ctx, child.ID)
	if revised.Claims[0].ID != claim.ID || revised.Claims[0].Session != first.Claims[0].Session || revised.Claims[0].Workspace != ws.ID || revised.Claims[0].Report == nil || revised.Claims[0].Report.Summary != "Revised report" {
		t.Fatalf("revised=%+v", revised)
	}
	body, err := os.ReadFile(filepath.Join(ws.Directory, "draft.txt"))
	if err != nil || string(body) != "First draft" {
		t.Fatalf("draft=%q err=%v", body, err)
	}
	if err := e.UpdateTask(ctx, root.ID, task.Update{Phase: task.PhaseIntegrating}, actor); err != nil {
		t.Fatal(err)
	}
	waitReview()
	if err := e.ReviewTask(ctx, root.ID, "owner", "approve", ""); err != nil {
		t.Fatal(err)
	}
	for {
		select {
		case fact := <-facts:
			if fact.Type == workspace.Released {
				released, _ := event.Decode[workspace.Workspace](fact)
				if released.ID == ws.ID {
					if _, err := os.Stat(ws.Directory); !os.IsNotExist(err) {
						t.Fatalf("delivered workspace still exists: %v", err)
					}
					return
				}
			}
		case <-ctx.Done():
			t.Fatal(ctx.Err())
		}
	}
}

func TestIntegratedWorktreeSurvivesGoalReviewAndReworksOnTheSameBranch(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()
	dir := enginetest.IntegrationRepository(t)
	coordinator := enginetest.GroupScript{ProviderName: "leader-model", Test: t, Reply: func(req model.Request) fake.Reply {
		for _, part := range req.Messages[len(req.Messages)-1].Parts {
			if part.ToolResult != nil {
				if part.ToolResult.IsError {
					t.Errorf("merge failed: %+v", part.ToolResult)
				}
				return fake.Reply{Text: "Recorded"}
			}
			marker := "(task.reported):\n"
			index := strings.Index(part.Text, marker)
			if index < 0 {
				continue
			}
			var card task.Card
			if json.NewDecoder(strings.NewReader(part.Text[index+len(marker):])).Decode(&card) != nil {
				t.Fatal("invalid reported task")
			}
			return enginetest.IntegrationCall("request_merge", map[string]any{"task": card.ID, "claim": card.Claims[0].ID})
		}
		return fake.Reply{Text: "Recorded"}
	}}
	workModel := fake.New(t,
		enginetest.IntegrationCall("bash", map[string]any{"command": "printf 'First\\n' > draft.txt && git add draft.txt && git commit -m 'First fixture result'"}),
		enginetest.IntegrationCall("submit_report", map[string]any{"verdict": "done", "summary": "First report"}),
		enginetest.IntegrationCall("bash", map[string]any{"command": "test -f draft.txt && printf 'Second\\n' >> draft.txt && git add draft.txt && git commit -m 'Revised fixture result'"}),
		enginetest.IntegrationCall("submit_report", map[string]any{"verdict": "done", "summary": "Revised report"}),
	)
	deps2 := enginetest.Deps(t)
	deps2.Workdir = dir
	deps2.Providers = map[string]model.Provider{"leader-model": coordinator, "worker-model": workModel}
	deps2.Ask = func(context.Context, permission.Request) (permission.Reply, error) {
		return permission.Reply{Decision: permission.Allow, Human: "owner"}, nil
	}
	e, err := engine.New(deps2)
	if err != nil {
		t.Fatal(err)
	}
	defer e.Close()
	lead := definition.DefaultMerakCode()
	lead.ID, lead.Model.Provider = "lead-profile", "leader-model"
	worker := definition.DefaultMerakCode()
	worker.Memory = []memory.Scope{}
	worker.ID, worker.Model.Provider = "worker-profile", "worker-model"
	g, err := enginetest.CreateGroup(t, e, ctx, group.Group{Kind: group.KindLocal, Name: "Group", Project: group.Project{Directory: dir}, Leader: "leader"}, []group.Member{
		{ID: "leader", Name: "Leader", Kind: group.MemberAgent, AgentRole: group.AgentLeader, Agent: lead.ID},
		{ID: "worker", Name: "Worker", Kind: group.MemberAgent, AgentRole: group.AgentWorker, Agent: worker.ID},
		{ID: "owner", Name: "Owner", Kind: group.MemberHuman, Role: group.RoleOwner},
	}, []definition.Agent{lead, worker})
	if err != nil {
		t.Fatal(err)
	}
	facts, stop := e.Subscribe(event.Filter{Scope: event.Scope{Group: g.ID}})
	defer stop()
	root, err := e.CreateTask(ctx, task.Card{Group: g.ID, Title: "Goal"})
	if err != nil {
		t.Fatal(err)
	}
	actor := event.Actor{Kind: event.ActorAgent, ID: "leader"}
	if err := e.UpdateTask(ctx, root.ID, task.Update{Phase: task.PhaseDoing}, actor); err != nil {
		t.Fatal(err)
	}
	child, err := e.CreateTask(ctx, task.Card{Group: g.ID, Parent: root.ID, Title: "Draft"})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := e.AssignTask(ctx, child.ID, "owner", "worker", task.RoleOwner, nil); err != nil {
		t.Fatal(err)
	}
	waitReview := func() {
		t.Helper()
		for {
			select {
			case fact := <-facts:
				if fact.Type == task.Reported && fact.Scope.Task == child.ID {
					card, _ := event.Decode[task.Card](fact)
					if card.Claims[0].Report.Verdict != task.VerdictDone {
						t.Fatalf("worker failed during review cycle: %+v", card.Claims[0].Report)
					}
					if err := e.UpdateTask(ctx, root.ID, task.Update{Phase: task.PhaseIntegrating}, actor); err != nil {
						t.Fatal(err)
					}
				}
				if fact.Type == group.NoticeSent && fact.Scope.Task == root.ID {
					notice, _ := event.Decode[group.Notice](fact)
					if notice.Kind == "review" {
						return
					}
				}
			case <-ctx.Done():
				t.Fatal(ctx.Err())
			}
		}
	}
	waitReview()
	first, _ := e.Task(ctx, child.ID)
	if err := e.ReviewTask(ctx, root.ID, "owner", "rework", "Add a second line"); err != nil {
		t.Fatal(err)
	}
	waitReview()
	revised, _ := e.Task(ctx, child.ID)
	if revised.Claims[0].ID != first.Claims[0].ID || revised.Claims[0].Session != first.Claims[0].Session || revised.Claims[0].Workspace != first.Claims[0].Workspace {
		t.Fatalf("claim changed: %+v", revised.Claims[0])
	}
	if err := e.ReviewTask(ctx, root.ID, "owner", "approve", ""); err != nil {
		t.Fatal(err)
	}
	body, err := os.ReadFile(filepath.Join(dir, "draft.txt"))
	if err != nil || string(body) != "First\nSecond\n" {
		t.Fatalf("target=%q err=%v", body, err)
	}
	for {
		select {
		case fact := <-facts:
			if fact.Type == workspace.Released {
				ws, _ := event.Decode[workspace.Workspace](fact)
				if ws.ID == first.Claims[0].Workspace {
					return
				}
			}
		case <-ctx.Done():
			t.Fatal(ctx.Err())
		}
	}
}
