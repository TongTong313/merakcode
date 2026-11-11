package engine_test

import (
	"context"
	"encoding/json"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/TongTong313/merakcode/merak/engine"
	"github.com/TongTong313/merakcode/merak/engine/agent"
	"github.com/TongTong313/merakcode/merak/engine/event"
	"github.com/TongTong313/merakcode/merak/engine/group"
	"github.com/TongTong313/merakcode/merak/engine/model"
	"github.com/TongTong313/merakcode/merak/engine/model/fake"
	"github.com/TongTong313/merakcode/merak/engine/permission"
	"github.com/TongTong313/merakcode/merak/engine/task"
	"github.com/TongTong313/merakcode/merak/internal/platform/process"
)

func fixtureGit(t *testing.T, dir string, args ...string) string {
	t.Helper()
	cmd := process.Command(context.Background(), dir, "git", args...)
	body, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("git %v: %v %s", args, err, body)
	}
	return strings.TrimSpace(string(body))
}

func integrationRepository(t *testing.T) string {
	t.Helper()
	dir := t.TempDir()
	t.Cleanup(func() {
		_ = filepath.WalkDir(dir, func(path string, entry fs.DirEntry, err error) error {
			if err == nil && !entry.IsDir() {
				_ = os.Chmod(path, 0600)
			}
			return nil
		})
	})
	fixtureGit(t, dir, "init", "-b", "main")
	fixtureGit(t, dir, "config", "user.name", "Fixture")
	fixtureGit(t, dir, "config", "user.email", "fixture@example.invalid")
	fixtureGit(t, dir, "config", "core.autocrlf", "false")
	if err := os.WriteFile(filepath.Join(dir, "README.md"), []byte("Baseline\n"), 0600); err != nil {
		t.Fatal(err)
	}
	fixtureGit(t, dir, "add", ".")
	fixtureGit(t, dir, "commit", "-m", "Baseline fixture")
	return dir
}

func integrationCall(name string, input any) fake.Reply {
	body, _ := json.Marshal(input)
	return fake.Reply{Calls: []model.ToolCall{{ID: string(event.NewID()), Name: name, Input: body}}}
}

func TestNestedFolderGroupDoesNotUseItsParentRepository(t *testing.T) {
	ctx := context.Background()
	repo := integrationRepository(t)
	dir := filepath.Join(repo, "nested")
	if err := os.Mkdir(dir, 0700); err != nil {
		t.Fatal(err)
	}
	e, err := engine.New(engine.Deps{Workdir: dir, Providers: map[string]model.Provider{"fake": fake.New(t)}})
	if err != nil {
		t.Fatal(err)
	}
	defer e.Close()
	p := agent.DefaultLeader()
	p.ID, p.Model.Provider = "profile", "fake"
	g, err := createGroup(t, e, ctx, group.Group{Kind: group.KindLocal, Name: "Nested folder", Project: group.Project{Directory: dir}, Leader: "leader"}, []group.Member{{ID: "leader", Name: "Leader", Kind: group.MemberAgent, AgentRole: group.AgentLeader, Agent: p.ID}}, []agent.Agent{p})
	if err != nil {
		t.Fatal(err)
	}
	if g.Brief.TargetBranch != "" {
		t.Fatalf("folder inherited a parent branch: %s", g.Brief.TargetBranch)
	}
	if branches := fixtureGit(t, repo, "branch", "--format=%(refname:short)"); branches != "main" {
		t.Fatalf("branches=%s", branches)
	}
}

func TestGroupWorkersUseSeparateWorktreesAndMergeBothResults(t *testing.T) {
	for _, conflict := range []bool{false, true} {
		name := "independent changes"
		if conflict {
			name = "conflict resolved by original member"
		}
		t.Run(name, func(t *testing.T) { runGroupIntegration(t, conflict, false, false) })
	}
}

func TestConflictResolutionPreservesTheHumanReviewRequirement(t *testing.T) {
	runGroupIntegration(t, true, true, false)
}

func TestMergeWaitsForOwnerApproval(t *testing.T) {
	runGroupIntegration(t, false, false, true)
}

func runGroupIntegration(t *testing.T, conflict, review, ownerApproval bool) {
	ctx, cancel := context.WithTimeout(context.Background(), 90*time.Second)
	defer cancel()
	dir := integrationRepository(t)
	var started atomic.Int32
	both := make(chan struct{})
	providers := map[string]model.Provider{}
	for _, name := range []string{"a", "b"} {
		var calls atomic.Int32
		providers[name] = groupScript{name: name, test: t, reply: func(req model.Request) fake.Reply {
			last := req.Messages[len(req.Messages)-1]
			for _, part := range last.Parts {
				if strings.Contains(part.Text, `"integrationOf"`) {
					return integrationCall("bash", map[string]any{"command": "git rebase refs/heads/main || (printf 'a\\nb\\n' > README.md && git add README.md && git -c core.editor=true rebase --continue)"})
				}
			}
			switch calls.Add(1) {
			case 1:
				if !strings.Contains(req.System, ".merak") {
					t.Error("worker did not receive an isolated worktree")
				}
				if started.Add(1) == 2 {
					close(both)
				}
				file := name + ".txt"
				if conflict {
					file = "README.md"
				}
				result := integrationCall("bash", map[string]any{"command": "printf '" + name + "\\n' > " + file + " && git add " + file + " && git commit -m 'Worker fixture'"})
				result.Hold = both
				return result
			default:
				for _, part := range last.Parts {
					if part.ToolResult != nil && part.ToolResult.IsError {
						t.Errorf("worker tool failed: %+v", part.ToolResult)
						cancel()
					}
				}
				return integrationCall("submit_report", map[string]any{"verdict": "done", "summary": name + " committed and verified."})
			}
		}}
	}
	providers["leader"] = groupScript{name: "leader", test: t, reply: func(req model.Request) fake.Reply {
		last := req.Messages[len(req.Messages)-1]
		// the one Leader thread of the group receives the events of both tasks in its batches: answer each of them
		var calls []model.ToolCall
		for _, part := range last.Parts {
			if part.ToolResult != nil {
				if part.ToolResult.IsError {
					t.Errorf("leader tool failed: %+v", part.ToolResult)
					cancel()
				}
				return fake.Reply{Text: "Waiting for the next event."}
			}
			// a batch holds several events in one text part
			for _, text := range strings.Split(part.Text, "Event ") {
				index := strings.Index(text, "):\n")
				if index < 0 {
					continue
				}
				switch {
				case strings.Contains(text, "(task.opened)"), strings.Contains(text, "(task.reported)"):
					var card task.Card
					if err := json.NewDecoder(strings.NewReader(text[index+3:])).Decode(&card); err != nil {
						t.Error(err)
						continue
					}
					if strings.Contains(text, "(task.opened)") {
						calls = append(calls, integrationCall("assign_task", map[string]any{"task": card.ID, "member": card.Title, "role": "owner", "scope": card.Areas}).Calls...)
					} else if !review {
						calls = append(calls, integrationCall("request_merge", map[string]any{"task": card.ID, "claim": card.Claims[0].ID}).Calls...)
					}
				case strings.Contains(text, "(merge.done)"):
					calls = append(calls, integrationCall("notify_human", map[string]any{"kind": "final", "text": "Integrated and verified."}).Calls...)
				}
			}
		}
		if len(calls) > 0 {
			return fake.Reply{Calls: calls}
		}
		return fake.Reply{Text: "Waiting."}
	}}
	var mergeApprovals atomic.Int32
	e, err := engine.New(engine.Deps{Workdir: dir, Providers: providers, Ask: func(_ context.Context, req permission.Request) (permission.Reply, error) {
		if req.Kind == "merge" {
			mergeApprovals.Add(1)
			if fixtureGit(t, dir, "rev-list", "--count", "main") != "1" && mergeApprovals.Load() == 1 {
				t.Error("target changed before first approval")
			}
		}
		return permission.Reply{Decision: permission.Allow}, nil
	}})
	if err != nil {
		t.Fatal(err)
	}
	defer e.Close()
	members := []group.Member{{ID: "human", Name: "Owner", Kind: group.MemberHuman, Role: "owner"}}
	var profiles []agent.Agent
	for _, name := range []string{"leader", "a", "b"} {
		p := agent.DefaultWorker()
		role := group.AgentWorker
		if name == "leader" {
			p = agent.DefaultLeader()
			role = group.AgentLeader
		}
		p.ID, p.Model.Provider = event.ID(name+"-profile"), name
		profiles = append(profiles, p)
		members = append(members, group.Member{ID: event.ID(name), Name: name, Kind: group.MemberAgent, AgentRole: role, Agent: p.ID, Owner: "human"})
	}
	settings := group.Settings{Review: new(false)}
	if !ownerApproval {
		settings.MergeNeedsOwner = new(false)
	}
	g, err := createGroup(t, e, ctx, group.Group{Kind: group.KindLocal, Name: "Project", Project: group.Project{Directory: dir}, Leader: "leader", Settings: settings}, members, profiles)
	if err != nil {
		t.Fatal(err)
	}
	facts, stop := e.Bus.Subscribe(event.Filter{Scope: event.Scope{Group: g.ID}})
	defer stop()
	for _, name := range []string{"a", "b"} {
		area := name + ".txt"
		if conflict {
			area = "README.md"
		}
		if _, err := e.CreateTask(ctx, task.Card{Group: g.ID, Title: name, Areas: []string{area}, Review: review, CreatedBy: event.Actor{Kind: event.ActorHuman, ID: "human"}}); err != nil {
			t.Fatal(err)
		}
	}
	merged, delivered, conflicts, integrations := 0, 0, 0, 0
	defer func() {
		if ownerApproval && mergeApprovals.Load() < 2 {
			t.Errorf("merge approvals=%d want at least 2", mergeApprovals.Load())
		}
		if !ownerApproval && mergeApprovals.Load() != 0 {
			t.Errorf("disabled approval asked %d times", mergeApprovals.Load())
		}
	}()
	for delivered < 2 {
		select {
		case fact := <-facts:
			if fact.Type == task.Reported {
				enterGoalIntegration(t, ctx, e, fact.Scope.Task)
			}
			if review && fact.Type == task.Reported {
				card, err := event.Decode[task.Card](fact)
				if err != nil || !card.Review {
					t.Fatalf("review requirement was lost: %+v %v", card, err)
				}
				if err := e.ReviewTask(ctx, card.ID, "human", "approve", ""); err != nil {
					t.Fatal(err)
				}
			}
			if fact.Type == "merge.conflicted" {
				conflicts++
			}
			if fact.Type == task.Created && strings.Contains(string(fact.Payload), `"integrationOf"`) {
				card, err := event.Decode[task.Card](fact)
				if err != nil {
					t.Fatal(err)
				}
				goal, err := e.Tasks.Get(ctx, card.Parent)
				if err != nil || goal.Phase != task.PhaseDoing {
					t.Fatalf("conflicted goal did not return to doing: %+v %v", goal, err)
				}
				integrations++
			}
			if fact.Type == "merge.done" {
				merged++
			}
			if fact.Type == group.NoticeSent {
				notice, err := event.Decode[group.Notice](fact)
				if err != nil {
					t.Fatal(err)
				}
				if notice.Kind == "final" {
					delivered++
				}
			}
		case <-ctx.Done():
			t.Fatalf("merged=%d delivered=%d conflicts=%d integrations=%d: %v", merged, delivered, conflicts, integrations, ctx.Err())
		}
	}
	if merged != 2 {
		t.Fatalf("merged=%d", merged)
	}
	if conflict {
		if conflicts != 1 || integrations != 1 {
			t.Fatalf("conflicts=%d integrations=%d", conflicts, integrations)
		}
		body, err := os.ReadFile(filepath.Join(dir, "README.md"))
		if err != nil || string(body) != "a\nb\n" {
			t.Fatalf("resolved=%q err=%v", body, err)
		}
	} else {
		for _, name := range []string{"a", "b"} {
			body, err := os.ReadFile(filepath.Join(dir, name+".txt"))
			if err != nil || string(body) != name+"\n" {
				t.Fatalf("%s=%q err=%v", name, body, err)
			}
		}
	}
	if branch := fixtureGit(t, dir, "branch", "--show-current"); branch != "main" {
		t.Fatalf("branch=%s", branch)
	}
}
