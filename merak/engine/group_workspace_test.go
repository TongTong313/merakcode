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
	"github.com/TongTong313/merakcode/merak/engine/session"
	"github.com/TongTong313/merakcode/merak/engine/task"
	"github.com/TongTong313/merakcode/merak/engine/workspace"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestFolderTaskPublishesDeclaredArtifactsAndWaitsForReview(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "input.txt"), []byte("Original"), 0600); err != nil {
		t.Fatal(err)
	}
	leadModel := groupScript{name: "leader", test: t, reply: func(req model.Request) fake.Reply {
		for _, part := range req.Messages[len(req.Messages)-1].Parts {
			if part.ToolResult != nil {
				if part.ToolResult.IsError {
					t.Errorf("publish failed: %+v", part.ToolResult)
				}
				return integrationCall("say", map[string]any{"text": "Published for review."})
			}
			index := strings.Index(part.Text, "(task.reported):\n")
			if index < 0 {
				continue
			}
			var card task.Card
			if err := json.NewDecoder(strings.NewReader(part.Text[index+len("(task.reported):\n"):])).Decode(&card); err != nil {
				t.Fatal(err)
			}
			return integrationCall("publish", map[string]any{"task": card.ID, "claim": card.Claims[0].ID})
		}
		return fake.Reply{Text: "Waiting."}
	}}
	workModel := fake.New(t,
		integrationCall("read_file", map[string]any{"path": "input.txt"}),
		integrationCall("write_file", map[string]any{"path": "input.txt", "content": "Revised"}),
		integrationCall("submit_report", map[string]any{"verdict": "done", "summary": "Revised and checked the document.", "artifacts": []map[string]any{{"path": "input.txt", "title": "Revised input"}}}),
	)
	e, err := engine.New(engine.Deps{Workdir: dir, Providers: map[string]model.Provider{"leader": leadModel, "worker": workModel}, Ask: func(context.Context, permission.Request) (permission.Reply, error) {
		return permission.Reply{Decision: permission.Allow}, nil
	}})
	if err != nil {
		t.Fatal(err)
	}
	defer e.Close()
	lead, work := profile.DefaultLeader(), profile.DefaultWorker()
	lead.ID, lead.Model.Provider = "leader-profile", "leader"
	work.ID, work.Model.Provider = "worker-profile", "worker"
	g, err := e.CreateGroup(ctx, group.Group{Kind: group.KindLocal, Name: "Documents", Project: group.Project{Directory: dir}, DefaultLeader: "leader"}, []group.Member{
		{ID: "human", Name: "Owner", Kind: group.MemberHuman, Role: "owner"},
		{ID: "leader", Name: "Leader", Kind: group.MemberAgent, AgentRole: group.AgentLeader, Profile: lead.ID},
		{ID: "worker", Name: "Worker", Kind: group.MemberAgent, AgentRole: group.AgentWorker, Profile: work.ID},
	}, []profile.Profile{lead, work})
	if err != nil {
		t.Fatal(err)
	}
	facts, stop := e.Bus.Subscribe(event.Filter{Scope: event.Scope{Group: g.ID}})
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
			current, err := e.Tasks.Get(ctx, card.ID)
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
			enterGoalIntegration(t, ctx, e, card.ID)
			waitGoalPhase(t, ctx, e, card.ID, task.PhaseReview)
			if err := e.ReviewTask(ctx, card.ID, "human", "approve", ""); err != nil {
				t.Fatal(err)
			}
			current, err = e.Tasks.Get(ctx, card.ID)
			if err != nil || current.Status != task.Done {
				t.Fatalf("approved=%+v err=%v", current, err)
			}
			for {
				ws, err := e.Workspaces.Get(ctx, current.Claims[0].Workspace)
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

func workspaceGroup(t *testing.T, dir string, providers map[string]model.Provider) (*engine.Engine, group.Group) {
	t.Helper()
	e, err := engine.New(engine.Deps{Workdir: dir, Providers: providers})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = e.Close() })
	lead, work := profile.DefaultLeader(), profile.DefaultWorker()
	lead.ID, lead.Model.Provider = "leader-profile", "leader"
	work.ID, work.Model.Provider = "worker-profile", "worker"
	g, err := e.CreateGroup(context.Background(), group.Group{Kind: group.KindLocal, Name: "Workspace", Project: group.Project{Directory: dir}, DefaultLeader: "leader"}, []group.Member{
		{ID: "human", Name: "Owner", Kind: group.MemberHuman, Role: "owner"},
		{ID: "leader", Name: "Leader", Kind: group.MemberAgent, AgentRole: group.AgentLeader, Profile: lead.ID},
		{ID: "worker", Name: "First worker", Kind: group.MemberAgent, AgentRole: group.AgentWorker, Profile: work.ID},
		{ID: "second", Name: "Second worker", Kind: group.MemberAgent, AgentRole: group.AgentWorker, Profile: work.ID},
	}, []profile.Profile{lead, work})
	if err != nil {
		t.Fatal(err)
	}
	return e, g
}

func TestNoneWorkspaceHasReadOnlyToolsAndCreatesNoDirectory(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	dir := t.TempDir()
	attempt := integrationCall("write_file", map[string]any{"path": "unexpected.txt", "content": "Unexpected"})
	attempt.Expect = func(req model.Request) error {
		for _, spec := range req.Tools {
			if spec.Name == "write_file" || spec.Name == "edit_file" || spec.Name == "bash" {
				t.Errorf("none workspace exposed %s", spec.Name)
			}
		}
		return nil
	}
	report := integrationCall("submit_report", map[string]any{"verdict": "done", "summary": "Research completed."})
	report.Expect = func(req model.Request) error {
		last := req.Messages[len(req.Messages)-1]
		if len(last.Parts) != 1 || last.Parts[0].ToolResult == nil || !last.Parts[0].ToolResult.IsError {
			t.Error("write was not rejected")
		}
		return nil
	}
	e, g := workspaceGroup(t, dir, map[string]model.Provider{"leader": groupScript{name: "leader", test: t, reply: func(model.Request) fake.Reply { return fake.Reply{Text: "Waiting."} }}, "worker": fake.New(t, attempt, report)})
	facts, stop := e.Bus.Subscribe(event.Filter{Scope: event.Scope{Group: g.ID}, Types: []event.Type{task.Reported}})
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
	first := integrationCall("submit_report", map[string]any{"verdict": "done", "summary": "First report awaiting review"})
	first.Hold = release
	first.Expect = func(model.Request) error { close(started); return nil }
	second := integrationCall("submit_report", map[string]any{"verdict": "done", "summary": "Copied final input"})
	second.Expect = func(req model.Request) error {
		body, _ := json.Marshal(req.Messages[len(req.Messages)-1])
		if !strings.Contains(string(body), "Final input") {
			t.Error("folder copied inputs before inplace finished")
		}
		return nil
	}
	leaderModel := groupScript{name: "leader", test: t, reply: func(req model.Request) fake.Reply {
		body, _ := json.Marshal(req.Messages[len(req.Messages)-1])
		if strings.Contains(string(body), "(human.said)") {
			return integrationCall("say", map[string]any{"text": "Still responsive"})
		}
		return fake.Reply{Text: "Waiting."}
	}}
	e, g := workspaceGroup(t, dir, map[string]model.Provider{"leader": leaderModel, "worker": fake.New(t, first, integrationCall("read_file", map[string]any{"path": "input.txt"}), second)})
	facts, stop := e.Bus.Subscribe(event.Filter{Scope: event.Scope{Group: g.ID}})
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
