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
	"github.com/TongTong313/merakcode/merak/engine/agent/session"
	"github.com/TongTong313/merakcode/merak/engine/collab/group"
	"github.com/TongTong313/merakcode/merak/engine/collab/task"
	"github.com/TongTong313/merakcode/merak/engine/collab/workspace"
	"github.com/TongTong313/merakcode/merak/engine/infra/event"
	"github.com/TongTong313/merakcode/merak/testkit/enginetest"
)

func TestFolderTaskPublishesDeclaredArtifactsAndWaitsForReview(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "input.txt"), []byte("Original"), 0600); err != nil {
		t.Fatal(err)
	}
	leadModel := enginetest.GroupScript{ProviderName: "leader", Test: t, Reply: func(req model.Request) fake.Reply {
		for _, part := range req.Messages[len(req.Messages)-1].Parts {
			if part.ToolResult != nil {
				if part.ToolResult.IsError {
					t.Errorf("publish failed: %+v", part.ToolResult)
				}
				return enginetest.IntegrationCall("say", map[string]any{"text": "Published for review."})
			}
			index := strings.Index(part.Text, "(task.reported):\n")
			if index < 0 {
				continue
			}
			var card task.Card
			if err := json.NewDecoder(strings.NewReader(part.Text[index+len("(task.reported):\n"):])).Decode(&card); err != nil {
				t.Fatal(err)
			}
			return enginetest.IntegrationCall("publish", map[string]any{"task": card.ID, "claim": card.Claims[0].ID})
		}
		return fake.Reply{Text: "Waiting."}
	}}
	workModel := fake.New(t,
		enginetest.IntegrationCall("read_file", map[string]any{"path": "input.txt"}),
		enginetest.IntegrationCall("write_file", map[string]any{"path": "input.txt", "content": "Revised"}),
		enginetest.IntegrationCall("submit_report", map[string]any{"verdict": "done", "summary": "Revised and checked the document.", "artifacts": []map[string]any{{"path": "input.txt", "title": "Revised input"}}}),
	)
	deps := enginetest.Deps(t)
	deps.Workdir = dir
	deps.Providers = map[string]model.Provider{"leader": leadModel, "worker": workModel}
	deps.Ask = func(context.Context, permission.Request) (permission.Reply, error) {
		return permission.Reply{Decision: permission.Allow}, nil
	}
	e, err := engine.New(deps)
	if err != nil {
		t.Fatal(err)
	}
	defer e.Close()
	lead, work := definition.DefaultMerakCode(), definition.DefaultMerakCode()
	work.Memory = []memory.Scope{}
	lead.ID, lead.Model.Provider = "leader-profile", "leader"
	work.ID, work.Model.Provider = "worker-profile", "worker"
	g, err := enginetest.CreateGroup(t, e, ctx, group.Group{Kind: group.KindLocal, Name: "Documents", Project: group.Project{Directory: dir}, Leader: "leader"}, []group.Member{
		{ID: "human", Name: "Owner", Kind: group.MemberHuman, Role: "owner"},
		{ID: "leader", Name: "Leader", Kind: group.MemberAgent, AgentRole: group.AgentLeader, Agent: lead.ID},
		{ID: "worker", Name: "Worker", Kind: group.MemberAgent, AgentRole: group.AgentWorker, Agent: work.ID},
	}, []definition.Agent{lead, work})
	if err != nil {
		t.Fatal(err)
	}
	facts, stop := e.Subscribe(event.Filter{Scope: event.Scope{Group: g.ID}})
	defer stop()
	card, err := e.CreateAssignedTask(ctx, task.Card{Group: g.ID, Title: "Revise document", Inputs: []string{"input.txt"}, Review: true, CreatedBy: event.Actor{Kind: event.ActorHuman, ID: "human"}}, "worker")
	if err != nil {
		t.Fatal(err)
	}
	if card.Workspace != workspace.KindFolder {
		t.Fatalf("default workspace=%q", card.Workspace)
	}
	var artifact workspace.Published
	for {
		select {
		case fact := <-facts:
			if fact.Type == workspace.ArtifactPublished {
				artifact, err = event.Decode[workspace.Published](fact)
				if err != nil {
					t.Fatal(err)
				}
			}
			if fact.Type != session.MessageCompleted || fact.Stream != event.Stream("group:"+g.ID) {
				continue
			}
			current, err := e.Task(ctx, card.ID)
			if err != nil || current.Status != task.Review || artifact.ID == "" {
				t.Fatalf("task=%+v artifact=%+v err=%v", current, artifact, err)
			}
			original, err := os.ReadFile(filepath.Join(dir, "input.txt"))
			if err != nil || string(original) != "Original" {
				t.Fatalf("project changed: %q %v", original, err)
			}
			body, _, err := e.ReadBlob(ctx, "mrk://blob/"+string(artifact.ID), 0, 1024)
			if err != nil || string(body) != "Revised" {
				t.Fatalf("blob=%q err=%v", body, err)
			}
			enginetest.EnterGoalIntegration(t, ctx, e, card.ID)
			enginetest.WaitGoalPhase(t, ctx, e, card.ID, task.PhaseReview)
			if err := e.ReviewTask(ctx, card.ID, "human", "approve", ""); err != nil {
				t.Fatal(err)
			}
			current, err = e.Task(ctx, card.ID)
			if err != nil || current.Status != task.Done {
				t.Fatalf("approved=%+v err=%v", current, err)
			}
			for {
				ws, err := e.Workspace(ctx, current.Claims[0].Workspace)
				if err != nil {
					t.Fatal(err)
				}
				if ws.Released {
					if _, err := os.Stat(ws.Directory); !os.IsNotExist(err) {
						t.Fatalf("approved folder remains: %v", err)
					}
					break
				}
				select {
				case <-ctx.Done():
					t.Fatal("approved folder was not released")
				case <-time.After(time.Millisecond):
				}
			}
			return
		case <-ctx.Done():
			t.Fatal(ctx.Err())
		}
	}
}

func TestNoneWorkspaceHasReadOnlyToolsAndCreatesNoDirectory(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	dir := t.TempDir()
	attempt := enginetest.IntegrationCall("write_file", map[string]any{"path": "unexpected.txt", "content": "Unexpected"})
	attempt.Expect = func(req model.Request) error {
		for _, spec := range req.Tools {
			if spec.Name == "write_file" || spec.Name == "edit_file" || spec.Name == "bash" {
				t.Errorf("none workspace exposed %s", spec.Name)
			}
		}
		return nil
	}
	report := enginetest.IntegrationCall("submit_report", map[string]any{"verdict": "done", "summary": "Research completed."})
	report.Expect = func(req model.Request) error {
		last := req.Messages[len(req.Messages)-1]
		if len(last.Parts) != 1 || last.Parts[0].ToolResult == nil || !last.Parts[0].ToolResult.IsError {
			t.Error("write was not rejected")
		}
		return nil
	}
	e, g := enginetest.WorkspaceGroup(t, dir, map[string]model.Provider{"leader": enginetest.GroupScript{ProviderName: "leader", Test: t, Reply: func(model.Request) fake.Reply { return fake.Reply{Text: "Waiting."} }}, "worker": fake.New(t, attempt, report)})
	facts, stop := e.Subscribe(event.Filter{Scope: event.Scope{Group: g.ID}, Types: []event.Type{task.Reported}})
	defer stop()
	_, err := e.CreateAssignedTask(ctx, task.Card{Group: g.ID, Title: "Research", Workspace: "none", CreatedBy: event.Actor{Kind: event.ActorHuman, ID: "human"}}, "worker")
	if err != nil {
		t.Fatal(err)
	}
	select {
	case <-facts:
	case <-ctx.Done():
		t.Fatal(ctx.Err())
	}
	entries, err := os.ReadDir(dir)
	if err != nil || len(entries) != 0 {
		t.Fatalf("none workspace changed project: %v %v", entries, err)
	}
}

func TestWaitingWorkspaceKeepsGroupResponsiveAndStartsAfterThePreviousReport(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 8*time.Second)
	defer cancel()
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "input.txt"), []byte("Original"), 0600); err != nil {
		t.Fatal(err)
	}
	release, started := make(chan struct{}), make(chan struct{})
	first := enginetest.IntegrationCall("submit_report", map[string]any{"verdict": "done", "summary": "First report awaiting review"})
	first.Hold = release
	first.Expect = func(model.Request) error { close(started); return nil }
	second := enginetest.IntegrationCall("submit_report", map[string]any{"verdict": "done", "summary": "Copied final input"})
	second.Expect = func(req model.Request) error {
		body, _ := json.Marshal(req.Messages[len(req.Messages)-1])
		if !strings.Contains(string(body), "Final input") {
			t.Error("folder copied inputs before inplace finished")
		}
		return nil
	}
	leaderModel := enginetest.GroupScript{ProviderName: "leader", Test: t, Reply: func(req model.Request) fake.Reply {
		body, _ := json.Marshal(req.Messages[len(req.Messages)-1])
		if strings.Contains(string(body), "(human.said)") {
			return enginetest.IntegrationCall("say", map[string]any{"text": "Still responsive"})
		}
		return fake.Reply{Text: "Waiting."}
	}}
	e, g := enginetest.WorkspaceGroup(t, dir, map[string]model.Provider{"leader": leaderModel, "worker": fake.New(t, first, enginetest.IntegrationCall("read_file", map[string]any{"path": "input.txt"}), second)})
	facts, stop := e.Subscribe(event.Filter{Scope: event.Scope{Group: g.ID}})
	defer stop()
	_, err := e.CreateAssignedTask(ctx, task.Card{Group: g.ID, Title: "Exclusive work", Workspace: "inplace", Review: true, CreatedBy: event.Actor{Kind: event.ActorHuman, ID: "human"}}, "worker")
	if err != nil {
		t.Fatal(err)
	}
	select {
	case <-started:
	case <-ctx.Done():
		t.Fatal(ctx.Err())
	}
	card, err := e.CreateAssignedTask(ctx, task.Card{Group: g.ID, Title: "Copy input", Workspace: "folder", Inputs: []string{"input.txt"}, CreatedBy: event.Actor{Kind: event.ActorHuman, ID: "human"}}, "second")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := e.SayGroup(ctx, g.ID, card.ID, "human", group.Message{Text: "Are you still responsive?", To: []event.ID{"leader"}}); err != nil {
		t.Fatal(err)
	}
	released := false
	for {
		select {
		case fact := <-facts:
			if fact.Type == workspace.Created && fact.Scope.Task == card.ID && !released {
				t.Fatal("conflicting workspace started before lease release")
			}
			if fact.Type == session.MessageCompleted && fact.Stream == event.Stream("group:"+g.ID) && !released {
				if err := os.WriteFile(filepath.Join(dir, "input.txt"), []byte("Final input"), 0600); err != nil {
					t.Fatal(err)
				}
				released = true
				close(release)
			}
			if fact.Type == task.Reported && fact.Scope.Task == card.ID {
				return
			}
		case <-ctx.Done():
			t.Fatal(ctx.Err())
		}
	}
}
