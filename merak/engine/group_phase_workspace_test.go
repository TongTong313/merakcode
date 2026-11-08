package engine_test

import (
	"context"
	"encoding/json"
	"github.com/TongTong313/merakcode/merak/engine"
	"github.com/TongTong313/merakcode/merak/engine/event"
	"github.com/TongTong313/merakcode/merak/engine/group"
	"github.com/TongTong313/merakcode/merak/engine/model"
	"github.com/TongTong313/merakcode/merak/engine/model/fake"
	"github.com/TongTong313/merakcode/merak/engine/permission"
	"github.com/TongTong313/merakcode/merak/engine/profile"
	"github.com/TongTong313/merakcode/merak/engine/task"
	"github.com/TongTong313/merakcode/merak/engine/workspace"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestGoalReviewRetainsChildFilesForReworkAndReleasesThemAfterDelivery(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 12*time.Second)
	defer cancel()
	dir := t.TempDir()
	quiet := groupScript{name: "leader-model", test: t, reply: func(model.Request) fake.Reply { return fake.Reply{Text: "Recorded"} }}
	workModel := fake.New(t,
		integrationCall("write_file", map[string]any{"path": "draft.txt", "content": "First draft"}),
		integrationCall("submit_report", map[string]any{"verdict": "done", "summary": "First report"}),
		integrationCall("read_file", map[string]any{"path": "draft.txt"}),
		integrationCall("submit_report", map[string]any{"verdict": "done", "summary": "Revised report"}),
	)
	e, err := engine.New(engine.Deps{Workdir: dir, Providers: map[string]model.Provider{"leader-model": quiet, "worker-model": workModel}, Ask: func(context.Context, permission.Request) (permission.Reply, error) {
		return permission.Reply{Decision: permission.Allow, Human: "owner"}, nil
	}})
	if err != nil {
		t.Fatal(err)
	}
	defer e.Close()
	lead := profile.DefaultLeader()
	lead.ID, lead.Model.Provider = "lead-profile", "leader-model"
	worker := profile.DefaultWorker()
	worker.ID, worker.Model.Provider = "worker-profile", "worker-model"
	g, err := e.CreateGroup(ctx, group.Group{Kind: group.KindLocal, Name: "Group", Project: group.Project{Directory: dir}, DefaultLeader: "leader"}, []group.Member{
		{ID: "leader", Name: "Leader", Kind: group.MemberAgent, AgentRole: group.AgentLeader, Profile: lead.ID},
		{ID: "worker", Name: "Worker", Kind: group.MemberAgent, AgentRole: group.AgentWorker, Profile: worker.ID},
		{ID: "owner", Name: "Owner", Kind: group.MemberHuman, Role: group.RoleOwner},
	}, []profile.Profile{lead, worker})
	if err != nil {
		t.Fatal(err)
	}
	facts, stop := e.Bus.Subscribe(event.Filter{Scope: event.Scope{Group: g.ID}})
	defer stop()
	root, err := e.CreateTask(ctx, task.Card{Group: g.ID, Title: "Goal", Workspace: "folder"})
	if err != nil {
		t.Fatal(err)
	}
	actor := event.Actor{Kind: event.ActorAgent, ID: "leader"}
	if err := e.Tasks.SetPhase(ctx, root.ID, task.PhaseDoing, actor); err != nil {
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
	first, _ := e.Tasks.Get(ctx, child.ID)
	if err := e.Tasks.Close(ctx, child.ID, task.Done); err != nil {
		t.Fatal(err)
	}
	if err := e.Tasks.SetPhase(ctx, root.ID, task.PhaseIntegrating, actor); err != nil {
		t.Fatal(err)
	}
	waitReview()
	ws, err := e.Workspaces.Get(ctx, first.Claims[0].Workspace)
	if err != nil || ws.Released {
		t.Fatalf("child workspace was released before goal review: %+v %v", ws, err)
	}
	if err := e.ReviewTask(ctx, root.ID, "owner", "rework", "Check the original draft again"); err != nil {
		t.Fatal(err)
	}
	waitReport()
	revised, _ := e.Tasks.Get(ctx, child.ID)
	if revised.Claims[0].ID != claim.ID || revised.Claims[0].Session != first.Claims[0].Session || revised.Claims[0].Workspace != ws.ID || revised.Claims[0].Report == nil || revised.Claims[0].Report.Summary != "Revised report" {
		t.Fatalf("revised=%+v", revised)
	}
	body, err := os.ReadFile(filepath.Join(ws.Directory, "draft.txt"))
	if err != nil || string(body) != "First draft" {
		t.Fatalf("draft=%q err=%v", body, err)
	}
	if err := e.Tasks.SetPhase(ctx, root.ID, task.PhaseIntegrating, actor); err != nil {
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
	dir := integrationRepository(t)
	coordinator := groupScript{name: "leader-model", test: t, reply: func(req model.Request) fake.Reply {
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
			return integrationCall("request_merge", map[string]any{"task": card.ID, "claim": card.Claims[0].ID})
		}
		return fake.Reply{Text: "Recorded"}
	}}
	workModel := fake.New(t,
		integrationCall("bash", map[string]any{"command": "printf 'First\\n' > draft.txt && git add draft.txt && git commit -m 'First fixture result'"}),
		integrationCall("submit_report", map[string]any{"verdict": "done", "summary": "First report"}),
		integrationCall("bash", map[string]any{"command": "test -f draft.txt && printf 'Second\\n' >> draft.txt && git add draft.txt && git commit -m 'Revised fixture result'"}),
		integrationCall("submit_report", map[string]any{"verdict": "done", "summary": "Revised report"}),
	)
	e, err := engine.New(engine.Deps{Workdir: dir, Providers: map[string]model.Provider{"leader-model": coordinator, "worker-model": workModel}, Ask: func(context.Context, permission.Request) (permission.Reply, error) {
		return permission.Reply{Decision: permission.Allow, Human: "owner"}, nil
	}})
	if err != nil {
		t.Fatal(err)
	}
	defer e.Close()
	lead := profile.DefaultLeader()
	lead.ID, lead.Model.Provider = "lead-profile", "leader-model"
	worker := profile.DefaultWorker()
	worker.ID, worker.Model.Provider = "worker-profile", "worker-model"
	g, err := e.CreateGroup(ctx, group.Group{Kind: group.KindLocal, Name: "Group", Project: group.Project{Directory: dir}, DefaultLeader: "leader"}, []group.Member{
		{ID: "leader", Name: "Leader", Kind: group.MemberAgent, AgentRole: group.AgentLeader, Profile: lead.ID},
		{ID: "worker", Name: "Worker", Kind: group.MemberAgent, AgentRole: group.AgentWorker, Profile: worker.ID},
		{ID: "owner", Name: "Owner", Kind: group.MemberHuman, Role: group.RoleOwner},
	}, []profile.Profile{lead, worker})
	if err != nil {
		t.Fatal(err)
	}
	facts, stop := e.Bus.Subscribe(event.Filter{Scope: event.Scope{Group: g.ID}})
	defer stop()
	root, err := e.CreateTask(ctx, task.Card{Group: g.ID, Title: "Goal"})
	if err != nil {
		t.Fatal(err)
	}
	actor := event.Actor{Kind: event.ActorAgent, ID: "leader"}
	if err := e.Tasks.SetPhase(ctx, root.ID, task.PhaseDoing, actor); err != nil {
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
					if err := e.Tasks.SetPhase(ctx, root.ID, task.PhaseIntegrating, actor); err != nil {
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
	first, _ := e.Tasks.Get(ctx, child.ID)
	if err := e.ReviewTask(ctx, root.ID, "owner", "rework", "Add a second line"); err != nil {
		t.Fatal(err)
	}
	waitReview()
	revised, _ := e.Tasks.Get(ctx, child.ID)
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
