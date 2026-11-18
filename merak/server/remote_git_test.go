package server_test

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/TongTong313/merakcode/merak/cloudlink"
	"github.com/TongTong313/merakcode/merak/engine"
	"github.com/TongTong313/merakcode/merak/engine/agent/definition"
	"github.com/TongTong313/merakcode/merak/engine/agent/model"
	"github.com/TongTong313/merakcode/merak/engine/agent/model/fake"
	"github.com/TongTong313/merakcode/merak/engine/agent/permission"
	"github.com/TongTong313/merakcode/merak/engine/collab/group"
	"github.com/TongTong313/merakcode/merak/engine/collab/task"
	"github.com/TongTong313/merakcode/merak/engine/collab/wire"
	"github.com/TongTong313/merakcode/merak/engine/collab/workspace"
	"github.com/TongTong313/merakcode/merak/engine/infra/event"
	"github.com/TongTong313/merakcode/merak/engine/infra/store"
	"github.com/TongTong313/merakcode/merak/protocol"
	"github.com/TongTong313/merakcode/merak/server"
	"github.com/TongTong313/merakcode/merak/testkit/enginetest"
)

func TestRemoteWorktreeReturnsThroughTheRepositoryRemote(t *testing.T) {
	for _, review := range []bool{false, true} {
		name := "without review"
		if review {
			name = "with human review"
		}
		t.Run(name, func(t *testing.T) { runRemoteWorktree(t, review) })
	}
}

func runRemoteWorktree(t *testing.T, review bool) {
	ctx, cancel := context.WithTimeout(t.Context(), 45*time.Second)
	defer cancel()
	aDir := enginetest.IntegrationRepository(t)
	remoteDir, bDir := t.TempDir(), t.TempDir()
	enginetest.FixtureGit(t, remoteDir, "init", "--bare", "-b", "main")
	enginetest.FixtureGit(t, aDir, "remote", "add", "origin", remoteDir)
	enginetest.FixtureGit(t, aDir, "push", "-u", "origin", "main")
	enginetest.FixtureGit(t, bDir, "clone", remoteDir, ".")
	enginetest.FixtureGit(t, bDir, "config", "user.name", "Fixture")
	enginetest.FixtureGit(t, bDir, "config", "user.email", "fixture@example.invalid")
	if err := os.WriteFile(filepath.Join(aDir, "new-base.txt"), []byte("Fetch this base\n"), 0600); err != nil {
		t.Fatal(err)
	}
	enginetest.FixtureGit(t, aDir, "add", "new-base.txt")
	enginetest.FixtureGit(t, aDir, "commit", "-m", "Advance task base")
	enginetest.FixtureGit(t, aDir, "push", "origin", "main")
	var turns atomic.Int32
	bProvider := enginetest.GroupScript{ProviderName: "device", Test: t, Reply: func(req model.Request) fake.Reply {
		if turns.Add(1) == 1 {
			if !strings.Contains(req.System, ".merak") {
				t.Error("remote worker is outside its worktree")
			}
			return enginetest.IntegrationCall("bash", map[string]any{"command": "printf 'Remote change\\n' > remote.txt && git add remote.txt && git commit -m 'Remote fixture'"})
		}
		for _, part := range req.Messages[len(req.Messages)-1].Parts {
			if part.ToolResult != nil && part.ToolResult.IsError {
				t.Errorf("remote tool failed: %+v", part.ToolResult)
				cancel()
			}
		}
		return enginetest.IntegrationCall("submit_report", map[string]any{"verdict": "done", "summary": "Committed remote result"})
	}}
	deps := enginetest.Deps(t)
	deps.Dial = cloudlink.Dial
	deps.Workdir = bDir
	deps.Providers = map[string]model.Provider{"device": bProvider}
	deps.Ask = func(context.Context, permission.Request) (permission.Reply, error) {
		return permission.Reply{Decision: permission.Allow}, nil
	}
	b, err := engine.New(deps)
	if err != nil {
		t.Fatal(err)
	}
	defer b.Close()
	wp := definition.DefaultMerakCode()
	wp.ID, wp.Model.Provider = "source-worker", "device"
	if _, err := b.SaveAgent(ctx, "local-human", wp); err != nil {
		t.Fatal(err)
	}
	if _, err := b.CreateGroup(ctx, group.Group{ID: "source", Kind: group.KindLocal, Name: "Source", Project: group.Project{Directory: t.TempDir()}, Leader: "leader"}, []group.Member{
		{ID: "local-human", Name: "Owner", Kind: group.MemberHuman, Role: group.RoleOwner},
		{ID: "leader", Name: "Leader", Kind: group.MemberAgent, AgentRole: group.AgentLeader, Agent: "builtin-merakcode"},
	}); err != nil {
		t.Fatal(err)
	}
	bServer, err := server.Start(b, t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer bServer.Close()
	bClient, err := protocol.Connect(ctx, bServer.Info.Endpoint, bServer.Info.Token, protocol.HelloParams{Protocol: protocol.Version})
	if err != nil {
		t.Fatal(err)
	}
	defer bClient.Close()
	remoteWorker := group.Member{ID: "worker", Kind: group.MemberAgent, Name: "Remote worker", AgentRole: group.AgentWorker, Agent: wp.ID, Checkouts: map[string]string{remoteDir: bDir}}
	if err := bClient.Call(ctx, "group.addMember", protocol.GroupAddMemberParams{Group: "source", Member: remoteWorker}, nil); err != nil {
		t.Fatal(err)
	}
	leader := enginetest.GroupScript{ProviderName: "leader", Test: t, Reply: func(req model.Request) fake.Reply {
		for _, part := range req.Messages[len(req.Messages)-1].Parts {
			if part.ToolResult != nil {
				if part.ToolResult.IsError {
					t.Errorf("merge tool failed: %+v", part.ToolResult)
					cancel()
				}
				return fake.Reply{Text: "Waiting"}
			}
			if !strings.Contains(part.Text, "(task.reported)") {
				continue
			}
			index := strings.Index(part.Text, "):\n")
			var card task.Card
			if index >= 0 && json.NewDecoder(strings.NewReader(part.Text[index+3:])).Decode(&card) == nil && card.Claims[0].Report.Verdict == task.VerdictDone {
				return enginetest.IntegrationCall("request_merge", map[string]any{"task": card.ID, "claim": card.Claims[0].ID})
			}
		}
		return fake.Reply{Text: "Waiting"}
	}}
	deps2 := enginetest.Deps(t)
	deps2.Dial = cloudlink.Dial
	deps2.DataDir = t.TempDir()
	deps2.Dirs = enginetest.Dirs(t, deps2.DataDir)
	deps2.Workdir = aDir
	deps2.Providers = map[string]model.Provider{"leader": leader}
	deps2.Ask = func(context.Context, permission.Request) (permission.Reply, error) {
		return permission.Reply{Decision: permission.Allow, Human: "local-human"}, nil
	}
	a, err := engine.New(deps2)
	if err != nil {
		t.Fatal(err)
	}
	defer a.Close()
	aServer, err := server.Start(a, t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer aServer.Close()
	client, err := protocol.Connect(ctx, aServer.Info.Endpoint, aServer.Info.Token, protocol.HelloParams{Protocol: protocol.Version})
	if err != nil {
		t.Fatal(err)
	}
	defer client.Close()
	var connection wire.RemoteConnection
	if err := client.Call(ctx, "remote.connect", wire.RemoteConnectParams{Endpoint: bServer.Info.Endpoint, Token: bServer.Info.Token}, &connection); err != nil {
		t.Fatal(err)
	}
	body, _ := json.Marshal(connection.Members)
	if !strings.Contains(string(body), `"checkouts"`) {
		t.Fatal("remote discovery dropped declared checkouts")
	}
	lp := definition.DefaultMerakCode()
	lp.ID, lp.Model.Provider = "host-leader", "leader"
	rp := definition.DefaultMerakCode()
	rp.ID = "remote-worker"
	rp.Product = &definition.Product{Kind: definition.KindRemote, Remote: &definition.RemoteSource{Connection: connection.ID, Group: "source", Member: "worker", Caps: definition.Caps{Steer: true, Permission: true}}}
	// the same remote source as a Leader: it can be saved, but it cannot take the Leader seat
	remoteLeader := definition.DefaultMerakCode()
	remoteLeader.ID, remoteLeader.Product = "remote-leader", rp.Product
	for _, a := range []definition.Agent{lp, rp} {
		if err := client.Call(ctx, "agent.save", protocol.AgentSaveParams{Agent: a}, nil); err != nil {
			t.Fatal(err)
		}
	}
	if err := client.Call(ctx, "agent.save", protocol.AgentSaveParams{Agent: remoteLeader}, nil); err != nil {
		t.Fatalf("an agent with a remote source: %v", err)
	}
	var g group.Group
	if err := client.Call(ctx, "group.create", protocol.GroupCreateParams{Group: group.Group{Kind: group.KindLocal, Name: "Host", Project: group.Project{Directory: aDir}, Leader: "leader", Brief: group.Brief{Check: "git diff --exit-code"}}, Members: []group.Member{
		{ID: "local-human", Name: "Owner", Kind: group.MemberHuman, Role: group.RoleOwner},
		{ID: "leader", Name: "Leader", Kind: group.MemberAgent, AgentRole: group.AgentLeader, Agent: lp.ID},
		{ID: "remote", Name: "Remote", Kind: group.MemberAgent, AgentRole: group.AgentWorker, Agent: rp.ID},
	}}, &g); err != nil {
		t.Fatal(err)
	}
	if err := client.Call(ctx, "group.update", map[string]any{"group": g.ID, "leader": remoteLeader.ID}, nil); err == nil || !strings.Contains(err.Error(), "MRK-6007") {
		t.Fatalf("a remote source in the Leader seat: %v", err)
	}
	for _, kind := range []string{"folder", "inplace"} {
		if err := client.Call(ctx, "task.create", protocol.TaskCreateParams{Group: g.ID, Member: "remote", Title: "Rejected " + kind, Workspace: kind}, nil); err == nil || !strings.Contains(err.Error(), "MRK-6001") {
			t.Fatalf("remote %s: %v", kind, err)
		}
	}
	noRemote, err := enginetest.CreateGroup(t, a, ctx, group.Group{Kind: group.KindLocal, Name: "No remote", Project: group.Project{Directory: enginetest.IntegrationRepository(t)}, Leader: "leader"}, []group.Member{
		{ID: "local-human", Name: "Owner", Kind: group.MemberHuman, Role: group.RoleOwner},
		{ID: "leader", Name: "Leader", Kind: group.MemberAgent, AgentRole: group.AgentLeader, Agent: lp.ID},
		{ID: "remote", Name: "Remote", Kind: group.MemberAgent, AgentRole: group.AgentWorker, Agent: rp.ID},
	}, nil)
	if err != nil {
		t.Fatal(err)
	}
	if err := client.Call(ctx, "task.create", protocol.TaskCreateParams{Group: noRemote.ID, Member: "remote", Title: "No remote", Workspace: "worktree"}, nil); err == nil || !strings.Contains(err.Error(), "MRK-6001") {
		t.Fatalf("worktree without remote: %v", err)
	}
	facts, stop := a.Subscribe(event.Filter{Scope: event.Scope{Group: g.ID}, Types: []event.Type{workspace.MergeDone, task.Updated}})
	defer stop()
	card, err := a.CreateAssignedTask(ctx, task.Card{Group: g.ID, Title: "Remote change", Workspace: "worktree", Review: review, CreatedBy: event.Actor{Kind: event.ActorHuman, ID: "local-human"}}, "remote")
	if err != nil {
		t.Fatal(err)
	}
	approved := false
	for {
		select {
		case fact := <-facts:
			if fact.Type == workspace.MergeDone {
				goto merged
			}
			if review && !approved {
				current, err := a.Task(ctx, card.ID)
				if err != nil {
					t.Fatal(err)
				}
				if len(current.Claims) == 0 || current.Claims[0].Workspace == "" {
					continue
				}
				ws, err := a.Workspace(ctx, current.Claims[0].Workspace)
				if err != nil {
					t.Fatal(err)
				}
				if diff := enginetest.FixtureGit(t, ws.Directory, "diff", current.Base, "HEAD"); !strings.Contains(diff, "Remote change") {
					t.Fatalf("local review diff: %s", diff)
				}
				if _, err := os.Stat(filepath.Join(aDir, "remote.txt")); !os.IsNotExist(err) {
					t.Fatal("merged before human review")
				}
				if err := a.ReviewTask(ctx, card.ID, "local-human", "approve", ""); err != nil {
					t.Fatal(err)
				}
				approved = true
			}
		case <-ctx.Done():
			t.Fatal("remote result was not integrated", ctx.Err())
		}
	}
merged:
	content, err := os.ReadFile(filepath.Join(aDir, "remote.txt"))
	if err != nil || string(content) != "Remote change\n" {
		t.Fatalf("host result: %q %v", content, err)
	}
	branch := "refs/heads/merak/" + string(card.ID) + "/remote"
	for enginetest.FixtureGit(t, aDir, "ls-remote", "origin", branch) != "" {
		select {
		case <-time.After(10 * time.Millisecond):
		case <-ctx.Done():
			t.Fatal("remote delivery branch was not removed")
		}
	}
	if _, err := os.Stat(filepath.Join(bDir, "remote.txt")); !os.IsNotExist(err) {
		t.Fatal("remote worker changed its source checkout")
	}
	released, stopReleased := b.Subscribe(event.Filter{Types: []event.Type{workspace.Released}})
	defer stopReleased()
	for {
		records, err := b.FindEvents(ctx, store.Query{Types: []event.Type{workspace.Released}})
		if err != nil {
			t.Fatal(err)
		}
		if len(records) > 0 {
			break
		}
		select {
		case <-released:
		case <-ctx.Done():
			t.Fatal("device worktree was not released")
		}
	}
}
