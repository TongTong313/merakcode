package sandbox_test

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/TongTong313/merakcode/merak/engine"
	"github.com/TongTong313/merakcode/merak/engine/agent/conversation"
	"github.com/TongTong313/merakcode/merak/engine/agent/definition"
	"github.com/TongTong313/merakcode/merak/engine/agent/loop"
	"github.com/TongTong313/merakcode/merak/engine/agent/model"
	"github.com/TongTong313/merakcode/merak/engine/agent/model/fake"
	"github.com/TongTong313/merakcode/merak/engine/agent/permission"
	"github.com/TongTong313/merakcode/merak/engine/agent/session"
	"github.com/TongTong313/merakcode/merak/engine/collab/group"
	"github.com/TongTong313/merakcode/merak/engine/collab/task"
	"github.com/TongTong313/merakcode/merak/engine/collab/workspace"
	"github.com/TongTong313/merakcode/merak/engine/infra/event"
	"github.com/TongTong313/merakcode/merak/engine/infra/process"
	"github.com/TongTong313/merakcode/merak/testkit/enginetest"
)

func TestAHumanWordRestartsAClaimOfAMemberThatCannotTakeMessagesMidRun(t *testing.T) {
	binary := filepath.Join(t.TempDir(), "command.exe")
	if out, err := process.Command(t.Context(), "", "go", "build", "-o", binary, "github.com/TongTong313/merakcode/merak/engine/collab/worker/command/testdata/fakecommand").CombinedOutput(); err != nil {
		t.Fatalf("build: %s %v", out, err)
	}
	ctx, cancel := context.WithTimeout(t.Context(), 30*time.Second)
	defer cancel()
	dir := enginetest.IntegrationRepository(t)
	var leaderCalls atomic.Int32
	leaderModel := enginetest.GroupScript{ProviderName: "leader", Test: t, Reply: func(model.Request) fake.Reply { leaderCalls.Add(1); return fake.Reply{Text: "Noted."} }}
	deps := enginetest.Deps(t)
	deps.Workdir = dir
	deps.Providers = map[string]model.Provider{"leader": leaderModel}
	e, err := engine.New(deps)
	if err != nil {
		t.Fatal(err)
	}
	defer e.Close()
	lead, work := definition.DefaultMerakCode(), definition.DefaultMerakCode()
	lead.ID, lead.Model.Provider = "leader-agent", "leader"
	work.ID, work.Mode = "worker-agent", permission.ModeTakeover
	work.Product = &definition.Product{Kind: definition.KindCommand, Binary: binary, Env: map[string]string{"MERAKCODE_FIXTURE_MODE": "hold-once"}}
	g, err := enginetest.CreateGroup(t, e, ctx, group.Group{Kind: group.KindLocal, Name: "Restart", Project: group.Project{Directory: dir}, Leader: "leader"}, []group.Member{
		{ID: "owner", Name: "Owner", Kind: group.MemberHuman, Role: group.RoleOwner},
		{ID: "leader", Name: "Leader", Kind: group.MemberAgent, AgentRole: group.AgentLeader, Agent: lead.ID},
		{ID: "worker", Name: "Worker", Kind: group.MemberAgent, AgentRole: group.AgentWorker, Agent: work.ID},
	}, []definition.Agent{lead, work})
	if err != nil {
		t.Fatal(err)
	}
	card, err := e.CreateAssignedTask(ctx, task.Card{Group: g.ID, Title: "Restyle", Workspace: workspace.KindInplace, Areas: []string{"."}, CreatedBy: event.Actor{Kind: event.ActorHuman, ID: "owner"}}, "worker")
	if err != nil {
		t.Fatal(err)
	}
	enginetest.WaitFor(t, ctx, "the first run to start", func() bool { _, err := os.Stat(filepath.Join(dir, "started.flag")); return err == nil })
	claim := card.Claims[0].ID
	calls := leaderCalls.Load()
	if _, err := e.SayGroup(ctx, g.ID, "", "owner", group.Message{To: []event.ID{"worker"}, Text: "Use the blue theme"}); err != nil {
		t.Fatal(err)
	}
	enginetest.WaitFor(t, ctx, "the claim to report after the restart", func() bool {
		current, err := e.Task(ctx, card.ID)
		return err == nil && len(current.Claims) == 1 && current.Claims[0].Status == task.ClaimReported
	})
	current, err := e.Task(ctx, card.ID)
	if err != nil || current.Claims[0].ID != claim {
		t.Fatalf("the restart created another claim: %+v %v", current.Claims, err)
	}
	input, err := os.ReadFile(filepath.Join(dir, "input.txt"))
	if err != nil || !strings.Contains(string(input), "Message from Owner (a human; this overrides the Leader's instructions): Use the blue theme") {
		t.Fatalf("the restarted run read %q, %v", input, err)
	}
	enginetest.WaitFor(t, ctx, "the Leader to be woken", func() bool { return leaderCalls.Load() > calls })
}

func TestEveryInputDeliveredToARunningMemberIsReceiptedAndLaterConsumed(t *testing.T) {
	ctx, cancel := context.WithTimeout(t.Context(), 10*time.Second)
	defer cancel()
	started := make(chan struct{})
	finish := make(chan struct{})
	report := enginetest.IntegrationCall("submit_report", map[string]any{"verdict": "done", "summary": "Verified."})
	report.Hold = finish
	workerModel := fake.New(t, fake.Reply{Hold: make(chan struct{}), Expect: func(model.Request) error { close(started); return nil }}, report)
	leaderModel := enginetest.GroupScript{ProviderName: "leader", Test: t, Reply: func(model.Request) fake.Reply { return fake.Reply{Text: "Noted."} }}
	dir := t.TempDir()
	deps2 := enginetest.Deps(t)
	deps2.Workdir = dir
	deps2.Providers = map[string]model.Provider{"leader": leaderModel, "worker": workerModel}
	e, err := engine.New(deps2)
	if err != nil {
		t.Fatal(err)
	}
	defer e.Close()
	lead, work := definition.DefaultMerakCode(), definition.DefaultMerakCode()
	lead.ID, lead.Model.Provider = "leader-agent", "leader"
	work.ID, work.Model.Provider = "worker-agent", "worker"
	g, err := enginetest.CreateGroup(t, e, ctx, group.Group{Kind: group.KindLocal, Name: "Receipts", Project: group.Project{Directory: dir}, Leader: "leader"}, []group.Member{
		{ID: "owner", Name: "Owner", Kind: group.MemberHuman, Role: group.RoleOwner},
		{ID: "leader", Name: "Leader", Kind: group.MemberAgent, AgentRole: group.AgentLeader, Agent: lead.ID},
		{ID: "worker", Name: "Worker", Kind: group.MemberAgent, AgentRole: group.AgentWorker, Agent: work.ID},
	}, []definition.Agent{lead, work})
	if err != nil {
		t.Fatal(err)
	}
	facts, stop := e.Subscribe(event.Filter{Scope: event.Scope{Group: g.ID}, Types: []event.Type{loop.InputDelivered, loop.InputConsumed}})
	defer stop()
	card, err := e.CreateAssignedTask(ctx, task.Card{Group: g.ID, Title: "Work", Workspace: workspace.KindNone, CreatedBy: event.Actor{Kind: event.ActorHuman, ID: "owner"}}, "worker")
	if err != nil {
		t.Fatal(err)
	}
	<-started
	said, err := e.SayGroup(ctx, g.ID, "", "owner", group.Message{To: []event.ID{"worker"}, Text: "Change of plan"})
	if err != nil {
		t.Fatal(err)
	}
	var delivered, consumed bool
	for !delivered || !consumed {
		select {
		case fact := <-facts:
			if fact.Cause != said {
				continue
			}
			if fact.Type == loop.InputDelivered {
				body, err := event.Decode[loop.Delivered](fact)
				if err != nil || body.Claim != card.Claims[0].ID || delivered {
					t.Fatalf("delivered=%+v err=%v", body, err)
				}
				delivered = true
			} else if !delivered {
				t.Fatal("the input was consumed before its delivery receipt")
			} else {
				consumed = true
			}
		case <-ctx.Done():
			t.Fatalf("delivered=%v consumed=%v", delivered, consumed)
		}
	}
	close(finish)
}

func TestTodoWriteKeepsTheLatestListInTheSessionSnapshotAndAnnouncesIt(t *testing.T) {
	ctx, cancel := context.WithTimeout(t.Context(), 10*time.Second)
	defer cancel()
	first := enginetest.IntegrationCall("todo_write", map[string]any{"items": []map[string]string{{"content": "Read", "status": "in_progress"}, {"content": "Write", "status": "pending"}}})
	second := enginetest.IntegrationCall("todo_write", map[string]any{"items": []map[string]string{{"content": "Read", "status": "done"}, {"content": "Write", "status": "in_progress"}}})
	deps3 := enginetest.Deps(t)
	deps3.Workdir = t.TempDir()
	deps3.Providers = map[string]model.Provider{"fake": fake.New(t, first, second, fake.Reply{Text: "Done."})}
	e, err := engine.New(deps3)
	if err != nil {
		t.Fatal(err)
	}
	defer e.Close()
	id, err := e.CreateSession(ctx, conversation.SessionOptions{Provider: "fake", Workdir: t.TempDir()})
	if err != nil {
		t.Fatal(err)
	}
	facts, stop := e.Subscribe(event.Filter{Types: []event.Type{session.TodoUpdated}})
	defer stop()
	if err := e.Send(ctx, id, []model.Part{{Text: "Plan the work"}}); err != nil {
		t.Fatal(err)
	}
	var announced int
	for announced < 2 {
		select {
		case <-facts:
			announced++
		case <-ctx.Done():
			t.Fatalf("todo.updated events: %d", announced)
		}
	}
	enginetest.WaitFor(t, ctx, "the snapshot to settle", func() bool {
		state, err := e.SessionSnapshot(ctx, id)
		return err == nil && len(state.Todos) == 2 && state.Todos[0].Status == "done" && state.Todos[1].Content == "Write" && state.Todos[1].Status == "in_progress"
	})
}

func TestLeaderAndWorkerBothHaveTheTodoTool(t *testing.T) {
	ctx, cancel := context.WithTimeout(t.Context(), 10*time.Second)
	defer cancel()
	seen := make(chan string, 4)
	has := func(role string) func(model.Request) fake.Reply {
		return func(req model.Request) fake.Reply {
			for _, spec := range req.Tools {
				if spec.Name == "todo_write" {
					select {
					case seen <- role:
					default:
					}
				}
			}
			return fake.Reply{Text: "Noted."}
		}
	}
	dir := t.TempDir()
	deps4 := enginetest.Deps(t)
	deps4.Workdir = dir
	deps4.Providers = map[string]model.Provider{
		"leader": enginetest.GroupScript{ProviderName: "leader", Test: t, Reply: has("leader")},
		"worker": enginetest.GroupScript{ProviderName: "worker", Test: t, Reply: has("worker")},
	}
	e, err := engine.New(deps4)
	if err != nil {
		t.Fatal(err)
	}
	defer e.Close()
	lead, work := definition.DefaultMerakCode(), definition.DefaultMerakCode()
	lead.ID, lead.Model.Provider = "leader-agent", "leader"
	work.ID, work.Model.Provider = "worker-agent", "worker"
	g, err := enginetest.CreateGroup(t, e, ctx, group.Group{Kind: group.KindLocal, Name: "Todos", Project: group.Project{Directory: dir}, Leader: "leader"}, []group.Member{
		{ID: "owner", Name: "Owner", Kind: group.MemberHuman, Role: group.RoleOwner},
		{ID: "leader", Name: "Leader", Kind: group.MemberAgent, AgentRole: group.AgentLeader, Agent: lead.ID},
		{ID: "worker", Name: "Worker", Kind: group.MemberAgent, AgentRole: group.AgentWorker, Agent: work.ID},
	}, []definition.Agent{lead, work})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := e.CreateAssignedTask(ctx, task.Card{Group: g.ID, Title: "Work", Workspace: workspace.KindNone, CreatedBy: event.Actor{Kind: event.ActorHuman, ID: "owner"}}, "worker"); err != nil {
		t.Fatal(err)
	}
	roles := map[string]bool{}
	for len(roles) < 2 {
		select {
		case role := <-seen:
			roles[role] = true
		case <-ctx.Done():
			t.Fatalf("todo_write was offered to %v", roles)
		}
	}
}
