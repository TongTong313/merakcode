package sandbox_test

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/TongTong313/merakcode/merak/engine"
	"github.com/TongTong313/merakcode/merak/engine/agent/definition"
	"github.com/TongTong313/merakcode/merak/engine/agent/model"
	"github.com/TongTong313/merakcode/merak/engine/agent/model/fake"
	"github.com/TongTong313/merakcode/merak/engine/agent/permission"
	"github.com/TongTong313/merakcode/merak/engine/agent/tool"
	"github.com/TongTong313/merakcode/merak/engine/collab/coordinator"
	"github.com/TongTong313/merakcode/merak/engine/collab/group"
	"github.com/TongTong313/merakcode/merak/engine/collab/task"
	"github.com/TongTong313/merakcode/merak/engine/collab/workspace"
	"github.com/TongTong313/merakcode/merak/engine/infra/event"
	"github.com/TongTong313/merakcode/merak/engine/infra/watch"
	"github.com/TongTong313/merakcode/merak/testkit/enginetest"
)

func TestInplaceMemberCommitsRetainOwnershipAlongsideHumanCommits(t *testing.T) {
	for _, kind := range []definition.Kind{definition.KindBuiltin, definition.KindCommand} {
		t.Run(string(kind), func(t *testing.T) { inplaceCommits(t, kind) })
	}
}

func inplaceCommits(t *testing.T, kind definition.Kind) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	directory := enginetest.IntegrationRepository(t)
	provider := fake.New(t, enginetest.IntegrationCall("bash", map[string]any{"command": "printf 'Member output\\n' > own.txt && git add own.txt && git commit -m 'Member edit'"}), fake.Reply{Hold: make(chan struct{})})
	leaderModel := enginetest.GroupScript{ProviderName: "leader", Test: t, Reply: func(model.Request) fake.Reply { return fake.Reply{Text: "Observed"} }}
	deps := enginetest.Deps(t)
	deps.Workdir = directory
	deps.Providers = map[string]model.Provider{"leader": leaderModel, "worker": provider}
	deps.Ask = func(context.Context, permission.Request) (permission.Reply, error) {
		return permission.Reply{Decision: permission.Allow, Human: "owner"}, nil
	}
	e, err := engine.New(deps)
	if err != nil {
		t.Fatal(err)
	}
	defer e.Close()
	lead, work := definition.DefaultMerakCode(), definition.DefaultMerakCode()
	lead.ID, lead.Model.Provider = "leader-profile", "leader"
	work.ID, work.Model.Provider = "worker-profile", "worker"
	if kind == definition.KindCommand {
		work.Product = &definition.Product{Kind: kind, Binary: "git", Args: []string{"commit", "--allow-empty", "-m", "Member command commit"}}
	}
	g, err := enginetest.CreateGroup(t, e, ctx, group.Group{Kind: group.KindLocal, Name: "Inplace commits", Project: group.Project{Directory: directory}, Leader: "leader", Settings: group.Settings{Initiative: group.Passive}}, []group.Member{
		{ID: "owner", Name: "Owner", Kind: group.MemberHuman, Role: group.RoleOwner},
		{ID: "leader", Name: "Leader", Kind: group.MemberAgent, AgentRole: group.AgentLeader, Agent: lead.ID},
		{ID: "worker", Name: "Worker", Kind: group.MemberAgent, AgentRole: group.AgentWorker, Agent: work.ID},
	}, []definition.Agent{lead, work})
	if err != nil {
		t.Fatal(err)
	}
	facts, stop := e.Subscribe(event.Filter{Scope: event.Scope{Group: g.ID}, Types: []event.Type{tool.Completed, task.Reported, "repo.changed"}})
	defer stop()
	card, err := e.CreateAssignedTask(ctx, task.Card{Group: g.ID, Title: "Commit inplace", Workspace: workspace.KindInplace, Areas: []string{"."}, CreatedBy: event.Actor{Kind: event.ActorHuman, ID: "owner"}}, "worker")
	if err != nil {
		t.Fatal(err)
	}
	for {
		select {
		case fact := <-facts:
			if fact.Type == task.Reported && kind == definition.KindCommand {
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
	own := enginetest.FixtureGit(t, directory, "rev-parse", "HEAD")
	if err := os.WriteFile(filepath.Join(directory, "human.txt"), []byte("Human output\n"), 0600); err != nil {
		t.Fatal(err)
	}
	enginetest.FixtureGit(t, directory, "add", "human.txt")
	enginetest.FixtureGit(t, directory, "commit", "-m", "Human edit")
	human := enginetest.FixtureGit(t, directory, "rev-parse", "HEAD")
	seenOwn, seenHuman := false, false
	for !seenOwn || !seenHuman {
		select {
		case fact := <-facts:
			if fact.Type != "repo.changed" {
				continue
			}
			change, err := event.Decode[coordinator.RepoChanges](fact)
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
	deps2 := enginetest.Deps(t)
	deps2.Workdir = directory
	deps2.Providers = map[string]model.Provider{"leader": fake.New(t, fake.Reply{Hold: make(chan struct{})})}
	e, err := engine.New(deps2)
	if err != nil {
		t.Fatal(err)
	}
	defer e.Close()
	facts, stop := e.Subscribe(event.Filter{Types: []event.Type{"sentinel.flagged", group.NoticeSent}})
	defer stop()
	lead := definition.DefaultMerakCode()
	lead.ID, lead.Model.Provider = "profile", "leader"
	ctx, cancel := context.WithTimeout(context.Background(), 12*time.Second)
	defer cancel()
	g, err := enginetest.CreateGroup(t, e, ctx, group.Group{Kind: group.KindLocal, Name: "Large project", Project: group.Project{Directory: directory}, Leader: "leader"}, []group.Member{{ID: "owner", Kind: group.MemberHuman, Name: "Owner", Role: group.RoleOwner}, {ID: "leader", Kind: group.MemberAgent, AgentRole: group.AgentLeader, Name: "Leader", Agent: lead.ID}}, []definition.Agent{lead})
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
					if duplicate.Type == coordinator.SentinelFlagged {
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
	directory := enginetest.IntegrationRepository(t)
	e, g := enginetest.WorkspaceGroup(t, directory, map[string]model.Provider{"leader": fake.New(t), "worker": fake.New(t)})
	facts, stop := e.Subscribe(event.Filter{Scope: event.Scope{Group: g.ID}, Types: []event.Type{"repo.changed", "file.changed"}})
	defer stop()
	if err := os.WriteFile(filepath.Join(directory, "README.md"), []byte("External revision\n"), 0600); err != nil {
		t.Fatal(err)
	}
	enginetest.FixtureGit(t, directory, "add", ".")
	enginetest.FixtureGit(t, directory, "commit", "-m", "External fixture revision")
	head := enginetest.FixtureGit(t, directory, "rev-parse", "HEAD")
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
	directory := enginetest.IntegrationRepository(t)
	release, started := make(chan struct{}), make(chan struct{})
	report := enginetest.IntegrationCall("submit_report", map[string]any{"verdict": "done", "summary": "Claim result"})
	report.Hold = release
	report.Expect = func(model.Request) error { close(started); return nil }
	e, g := enginetest.WorkspaceGroup(t, directory, map[string]model.Provider{
		"leader": enginetest.GroupScript{ProviderName: "leader", Test: t, Reply: func(model.Request) fake.Reply { return fake.Reply{Text: "Observed"} }},
		"worker": fake.New(t, report),
	})
	settings := g.Settings
	settings.MergeNeedsOwner = new(false)
	if _, err := e.UpdateGroup(ctx, g.ID, "human", group.Update{Settings: &settings}); err != nil {
		t.Fatal(err)
	}
	facts, stop := e.Subscribe(event.Filter{Scope: event.Scope{Group: g.ID}, Types: []event.Type{"repo.changed", "file.changed"}})
	defer stop()
	base := enginetest.FixtureGit(t, directory, "rev-parse", "HEAD")
	card, err := e.CreateAssignedTask(ctx, task.Card{ID: "claim-task", Title: "Claim work", Group: g.ID, Workspace: workspace.KindWorktree, Base: base, CreatedBy: event.Actor{Kind: event.ActorHuman, ID: "human"}}, "worker")
	if err != nil {
		t.Fatal(err)
	}
	select {
	case <-started:
	case <-ctx.Done():
		t.Fatal(ctx.Err())
	}
	card, err = e.Task(ctx, card.ID)
	if err != nil || len(card.Claims) != 1 {
		t.Fatalf("claim preparation: %+v %v", card, err)
	}
	claim := card.Claims[0]
	ws, err := e.Workspace(ctx, claim.Workspace)
	if err != nil {
		t.Fatal(err)
	}
	reports, stopReports := e.Subscribe(event.Filter{Scope: event.Scope{Group: g.ID, Task: card.ID}, Types: []event.Type{task.Reported}})
	defer stopReports()
	merged, stopMerged := e.Subscribe(event.Filter{Scope: event.Scope{Group: g.ID, Task: card.ID}, Types: []event.Type{workspace.MergeDone}})
	defer stopMerged()
	if err := os.WriteFile(filepath.Join(directory, "outside.md"), []byte("External\n"), 0600); err != nil {
		t.Fatal(err)
	}
	enginetest.FixtureGit(t, directory, "add", "outside.md")
	enginetest.FixtureGit(t, directory, "commit", "-m", "External change")
	external := enginetest.FixtureGit(t, directory, "rev-parse", "HEAD")
	if err := os.WriteFile(filepath.Join(ws.Directory, "result.md"), []byte("Claim result\n"), 0600); err != nil {
		t.Fatal(err)
	}
	enginetest.FixtureGit(t, ws.Directory, "add", "result.md")
	enginetest.FixtureGit(t, ws.Directory, "commit", "-m", "Claim result")
	close(release)
	select {
	case <-reports:
	case <-ctx.Done():
		t.Fatal(ctx.Err())
	}
	if err := e.ReviewTask(ctx, card.ID, "human", "approve", ""); err != nil {
		t.Fatal(err)
	}
	var integration workspace.Integration
	select {
	case fact := <-merged:
		integration, err = event.Decode[workspace.Integration](fact)
		if err != nil {
			t.Fatal(err)
		}
	case <-ctx.Done():
		t.Fatal(ctx.Err())
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
	release, started := make(chan struct{}), make(chan struct{})
	report := enginetest.IntegrationCall("submit_report", map[string]any{"verdict": "done", "summary": "Claim finished"})
	report.Hold = release
	report.Expect = func(model.Request) error { close(started); return nil }
	e, g := enginetest.TriggerGroup(t, group.Settings{Initiative: group.Passive}, map[string]model.Provider{
		"leader": enginetest.GroupScript{ProviderName: "leader", Test: t, Reply: func(model.Request) fake.Reply { return fake.Reply{Text: "Observed"} }},
		"worker": fake.New(t, report),
	})
	facts, stop := e.Subscribe(event.Filter{Scope: event.Scope{Group: g.ID}, Types: []event.Type{"file.changed"}})
	defer stop()
	card, err := e.CreateAssignedTask(ctx, task.Card{ID: "inplace-task", Title: "Inplace work", Group: g.ID, Workspace: workspace.KindInplace, CreatedBy: event.Actor{Kind: event.ActorHuman, ID: "owner"}}, "worker")
	if err != nil {
		t.Fatal(err)
	}
	select {
	case <-started:
	case <-ctx.Done():
		t.Fatal(ctx.Err())
	}
	card, err = e.Task(ctx, card.ID)
	if err != nil || len(card.Claims) != 1 {
		t.Fatalf("claim preparation: %+v %v", card, err)
	}
	ws, err := e.Workspace(ctx, card.Claims[0].Workspace)
	if err != nil {
		t.Fatal(err)
	}
	idle, stopIdle := e.Subscribe(event.Filter{Scope: event.Scope{Group: g.ID, Task: card.ID}, Types: []event.Type{workspace.Idle}})
	defer stopIdle()
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
	close(release)
	select {
	case <-idle:
	case <-ctx.Done():
		t.Fatal(ctx.Err())
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
		changed, err := event.Decode[coordinator.FileChanges](fact)
		if err != nil || len(changed.Paths) != 1 || changed.Paths[0] != "output.txt" {
			t.Fatalf("change=%+v, %v", changed, err)
		}
	case <-ctx.Done():
		t.Fatal("watcher did not resume")
	}
}
