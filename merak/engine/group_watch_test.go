package engine_test

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
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
	"github.com/TongTong313/merakcode/merak/engine/tool"
	"github.com/TongTong313/merakcode/merak/engine/worker"
	"github.com/TongTong313/merakcode/merak/engine/workspace"
	"github.com/TongTong313/merakcode/merak/internal/platform/watch"
)

func TestInplaceMemberCommitsRetainOwnershipAlongsideHumanCommits(t *testing.T) {
	for _, kind := range []worker.Kind{worker.KindBuiltin, worker.KindCommand} {
		t.Run(string(kind), func(t *testing.T) { inplaceCommits(t, kind) })
	}
}

func inplaceCommits(t *testing.T, kind worker.Kind) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	directory := integrationRepository(t)
	provider := fake.New(t, integrationCall("bash", map[string]any{"command": "printf 'Member output\\n' > own.txt && git add own.txt && git commit -m 'Member edit'"}), fake.Reply{Hold: make(chan struct{})})
	leaderModel := groupScript{name: "leader", test: t, reply: func(model.Request) fake.Reply { return fake.Reply{Text: "Observed"} }}
	e, err := engine.New(engine.Deps{Workdir: directory, Providers: map[string]model.Provider{"leader": leaderModel, "worker": provider}, Ask: func(context.Context, permission.Request) (permission.Reply, error) {
		return permission.Reply{Decision: permission.Allow, Human: "owner"}, nil
	}})
	if err != nil {
		t.Fatal(err)
	}
	defer e.Close()
	lead, work := agent.DefaultLeader(), agent.DefaultWorker()
	lead.ID, lead.Model.Provider = "leader-profile", "leader"
	work.ID, work.Model.Provider = "worker-profile", "worker"
	if kind == worker.KindCommand {
		work.Product = &agent.Product{Kind: kind, Binary: "git", Args: []string{"commit", "--allow-empty", "-m", "Member command commit"}}
	}
	g, err := createGroup(t, e, ctx, group.Group{Kind: group.KindLocal, Name: "Inplace commits", Project: group.Project{Directory: directory}, Leader: "leader", Settings: group.Settings{Initiative: group.Passive}}, []group.Member{
		{ID: "owner", Name: "Owner", Kind: group.MemberHuman, Role: group.RoleOwner},
		{ID: "leader", Name: "Leader", Kind: group.MemberAgent, AgentRole: group.AgentLeader, Agent: lead.ID},
		{ID: "worker", Name: "Worker", Kind: group.MemberAgent, AgentRole: group.AgentWorker, Agent: work.ID},
	}, []agent.Agent{lead, work})
	if err != nil {
		t.Fatal(err)
	}
	facts, stop := e.Bus.Subscribe(event.Filter{Scope: event.Scope{Group: g.ID}, Types: []event.Type{tool.Completed, task.Reported, "repo.changed"}})
	defer stop()
	card, err := e.CreateAssignedTask(ctx, task.Card{Group: g.ID, Title: "Commit inplace", Workspace: workspace.KindInplace, Areas: []string{"."}, CreatedBy: event.Actor{Kind: event.ActorHuman, ID: "owner"}}, "worker")
	if err != nil {
		t.Fatal(err)
	}
	for {
		select {
		case fact := <-facts:
			if fact.Type == task.Reported && kind == worker.KindCommand {
				goto committed
			}
			if fact.Type != tool.Completed {
				continue
			}
			result, err := event.Decode[tool.Completion](fact)
			if err == nil && result.Name == "sandbox_launch" {
				if result.IsError {
					t.Fatalf("member startup was denied: %+v", result)
				}
				continue
			}
			if err != nil || result.Result.IsError {
				t.Fatalf("worker commit=%+v, %v", result, err)
			}
			goto committed
		case <-ctx.Done():
			t.Fatal("member did not commit")
		}
	}
committed:
	own := fixtureGit(t, directory, "rev-parse", "HEAD")
	if err := os.WriteFile(filepath.Join(directory, "human.txt"), []byte("Human output\n"), 0600); err != nil {
		t.Fatal(err)
	}
	fixtureGit(t, directory, "add", "human.txt")
	fixtureGit(t, directory, "commit", "-m", "Human edit")
	human := fixtureGit(t, directory, "rev-parse", "HEAD")
	seenOwn, seenHuman := false, false
	for !seenOwn || !seenHuman {
		select {
		case fact := <-facts:
			if fact.Type != "repo.changed" {
				continue
			}
			change, err := event.Decode[engine.RepoChanges](fact)
			if err != nil {
				t.Fatal(err)
			}
			for _, commit := range change.Commits {
				if commit.ID == own {
					if change.Claims[own] != card.Claims[0].ID {
						t.Fatalf("member commit lost ownership: %v", change.Claims)
					}
					seenOwn = true
				}
				if commit.ID == human {
					if change.Claims[human] != "" {
						t.Fatalf("human commit attributed to member: %v", change.Claims)
					}
					seenHuman = true
				}
			}
		case <-ctx.Done():
			t.Fatal("missing commit observations")
		}
	}
}

func TestWatcherOverloadNotifiesTheOwnerOnce(t *testing.T) {
	directory := t.TempDir()
	for index := 0; index < 50001; index++ {
		if err := os.WriteFile(filepath.Join(directory, fmt.Sprintf("%05d.txt", index)), nil, 0600); err != nil {
			t.Fatal(err)
		}
	}
	e, err := engine.New(engine.Deps{Workdir: directory, Providers: map[string]model.Provider{"leader": fake.New(t, fake.Reply{Hold: make(chan struct{})})}})
	if err != nil {
		t.Fatal(err)
	}
	defer e.Close()
	facts, stop := e.Bus.Subscribe(event.Filter{Types: []event.Type{"sentinel.flagged", group.NoticeSent}})
	defer stop()
	lead := agent.DefaultLeader()
	lead.ID, lead.Model.Provider = "profile", "leader"
	ctx, cancel := context.WithTimeout(context.Background(), 12*time.Second)
	defer cancel()
	g, err := createGroup(t, e, ctx, group.Group{Kind: group.KindLocal, Name: "Large project", Project: group.Project{Directory: directory}, Leader: "leader"}, []group.Member{{ID: "owner", Kind: group.MemberHuman, Name: "Owner", Role: group.RoleOwner}, {ID: "leader", Kind: group.MemberAgent, AgentRole: group.AgentLeader, Name: "Leader", Agent: lead.ID}}, []agent.Agent{lead})
	if err != nil {
		t.Fatal(err)
	}
	var finding event.ID
	for {
		select {
		case fact := <-facts:
			if fact.Scope.Group != g.ID {
				t.Fatalf("wrong group: %+v", fact.Scope)
			}
			if fact.Type == "sentinel.flagged" {
				if finding != "" {
					t.Fatal("duplicate overload finding")
				}
				finding = fact.ID
				var body struct {
					Code string `json:"code"`
					Rule string `json:"rule"`
				}
				if err := json.Unmarshal(fact.Payload, &body); err != nil || body.Code != "MRK-1005" || body.Rule != "watch.overload" {
					t.Fatalf("finding=%s, %v", fact.Payload, err)
				}
				continue
			}
			notice, err := event.Decode[group.Notice](fact)
			if err != nil || finding == "" || fact.Cause != finding || len(notice.To) != 1 || notice.To[0] != "owner" || notice.Text != "MRK-1005" {
				t.Fatalf("notice=%+v cause=%s, %v", notice, fact.Cause, err)
			}
			deadline := time.After(6 * time.Second)
			for {
				select {
				case duplicate := <-facts:
					if duplicate.Type == engine.SentinelFlagged {
						t.Fatal("persistent overload repeated")
					}
					if duplicate.Type == group.NoticeSent && duplicate.Cause == finding {
						t.Fatal("owner received the same overload notice twice")
					}
				case <-deadline:
					return
				}
			}
		case <-ctx.Done():
			t.Fatal("initial overload did not notify owner")
		}
	}
}

func TestGroupRecordsExternalRepositoryAndFileChanges(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	directory := integrationRepository(t)
	e, g := workspaceGroup(t, directory, map[string]model.Provider{"leader": fake.New(t), "worker": fake.New(t)})
	facts, stop := e.Bus.Subscribe(event.Filter{Scope: event.Scope{Group: g.ID}, Types: []event.Type{"repo.changed", "file.changed"}})
	defer stop()
	if err := os.WriteFile(filepath.Join(directory, "README.md"), []byte("External revision\n"), 0600); err != nil {
		t.Fatal(err)
	}
	fixtureGit(t, directory, "add", ".")
	fixtureGit(t, directory, "commit", "-m", "External fixture revision")
	head := fixtureGit(t, directory, "rev-parse", "HEAD")
	seen := map[event.Type]bool{}
	for len(seen) != 2 {
		select {
		case fact := <-facts:
			if fact.Actor.Kind != "external" || fact.Stream != event.Stream("group:"+g.ID) {
				t.Fatalf("envelope=%+v", fact)
			}
			if fact.Type == "repo.changed" {
				changed, err := event.Decode[watch.RepoChanged](fact)
				if err != nil || changed.Head != head || len(changed.Commits) != 1 || changed.Commits[0].Paths[0] != "README.md" {
					t.Fatalf("repository=%+v, %v", changed, err)
				}
			} else {
				var payload struct {
					Paths []string `json:"paths"`
				}
				if err := json.Unmarshal(fact.Payload, &payload); err != nil || len(payload.Paths) != 1 || payload.Paths[0] != "README.md" {
					t.Fatalf("files=%+v, %v", payload, err)
				}
			}
			seen[fact.Type] = true
		case <-ctx.Done():
			t.Fatalf("missing watcher events: %v", seen)
		}
	}
}

func TestWatchersDistinguishIntegratedClaimChangesFromExternalChanges(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 25*time.Second)
	defer cancel()
	directory := integrationRepository(t)
	e, g := workspaceGroup(t, directory, map[string]model.Provider{"leader": groupScript{name: "leader", test: t, reply: func(model.Request) fake.Reply { return fake.Reply{Text: "Observed"} }}})
	facts, stop := e.Bus.Subscribe(event.Filter{Scope: event.Scope{Group: g.ID}, Types: []event.Type{"repo.changed", "file.changed"}})
	defer stop()
	base := fixtureGit(t, directory, "rev-parse", "HEAD")
	card := task.Card{ID: "claim-task", Group: g.ID, Workspace: workspace.KindWorktree, Base: base}
	claim := task.Claim{ID: "own-claim", Task: card.ID, Member: "worker", Status: task.ClaimActive}
	ws, err := e.Workspaces.ForClaim(ctx, directory, claim, card)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(directory, "outside.md"), []byte("External\n"), 0600); err != nil {
		t.Fatal(err)
	}
	fixtureGit(t, directory, "add", "outside.md")
	fixtureGit(t, directory, "commit", "-m", "External change")
	external := fixtureGit(t, directory, "rev-parse", "HEAD")
	if err := os.WriteFile(filepath.Join(ws.Directory, "result.md"), []byte("Claim result\n"), 0600); err != nil {
		t.Fatal(err)
	}
	fixtureGit(t, ws.Directory, "add", "result.md")
	fixtureGit(t, ws.Directory, "commit", "-m", "Claim result")
	integration, err := e.Workspaces.Integrate(ctx, ws, "main", "")
	if err != nil {
		t.Fatal(err)
	}
	seenRepository, seenFiles := false, false
	for !seenRepository || !seenFiles {
		select {
		case fact := <-facts:
			var payload struct {
				Commits []watch.Commit      `json:"commits"`
				Paths   []string            `json:"paths"`
				Claims  map[string]event.ID `json:"claims"`
			}
			if err := json.Unmarshal(fact.Payload, &payload); err != nil {
				t.Fatal(err)
			}
			if payload.Claims[external] != "" || payload.Claims["outside.md"] != "" {
				t.Fatalf("external change attributed to claim: %v", payload.Claims)
			}
			if fact.Type == "repo.changed" {
				for _, commit := range payload.Commits {
					if commit.ID != integration.Head {
						continue
					}
					if payload.Claims[commit.ID] != claim.ID {
						t.Fatalf("own commit has no attribution: %v", payload.Claims)
					}
					seenRepository = true
				}
			}
			if fact.Type == "file.changed" {
				for _, name := range payload.Paths {
					if name == "result.md" {
						if payload.Claims[name] != claim.ID {
							t.Fatalf("own file has no attribution: %v", payload.Claims)
						}
						seenFiles = true
					}
				}
			}
		case <-ctx.Done():
			t.Fatalf("missing attributed events: repository=%v files=%v", seenRepository, seenFiles)
		}
	}
}

func TestWatcherExcludesInplaceClaimsAndResumesAfterTheyEnd(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 25*time.Second)
	defer cancel()
	e, g := triggerGroup(t, group.Settings{Initiative: group.Passive}, map[string]model.Provider{"leader": fake.New(t)})
	facts, stop := e.Bus.Subscribe(event.Filter{Scope: event.Scope{Group: g.ID}, Types: []event.Type{"file.changed"}})
	defer stop()
	card := task.Card{ID: "inplace-task", Group: g.ID, Workspace: workspace.KindInplace}
	claim := task.Claim{ID: "inplace-claim", Task: card.ID, Member: "worker", Status: task.ClaimActive}
	ws, err := e.Workspaces.ForClaim(ctx, g.Project.Directory, claim, card)
	if err != nil {
		t.Fatal(err)
	}
	name := filepath.Join(ws.Directory, "output.txt")
	if err := os.WriteFile(name, []byte("Claim output"), 0600); err != nil {
		t.Fatal(err)
	}
	select {
	case fact := <-facts:
		t.Fatalf("claim write reported as external: %s", fact.Payload)
	case <-time.After(5500 * time.Millisecond):
	case <-ctx.Done():
		t.Fatal(ctx.Err())
	}
	if err := e.Workspaces.EndClaim(ctx, ws); err != nil {
		t.Fatal(err)
	}
	select {
	case fact := <-facts:
		t.Fatalf("ended claim reported as external: %s", fact.Payload)
	case <-time.After(10 * time.Second):
	case <-ctx.Done():
		t.Fatal(ctx.Err())
	}
	if err := os.WriteFile(name, []byte("External change after claim ended"), 0600); err != nil {
		t.Fatal(err)
	}
	select {
	case fact := <-facts:
		changed, err := event.Decode[engine.FileChanges](fact)
		if err != nil || len(changed.Paths) != 1 || changed.Paths[0] != "output.txt" {
			t.Fatalf("change=%+v, %v", changed, err)
		}
	case <-ctx.Done():
		t.Fatal("watcher did not resume")
	}
}
