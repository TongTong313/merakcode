package engine_test

import (
	"context"
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
	"github.com/TongTong313/merakcode/merak/engine/loop"
	"github.com/TongTong313/merakcode/merak/engine/model"
	"github.com/TongTong313/merakcode/merak/engine/model/fake"
	"github.com/TongTong313/merakcode/merak/engine/permission"
	"github.com/TongTong313/merakcode/merak/engine/session"
	"github.com/TongTong313/merakcode/merak/engine/task"
	"github.com/TongTong313/merakcode/merak/engine/worker"
	"github.com/TongTong313/merakcode/merak/engine/workspace"
	"github.com/TongTong313/merakcode/merak/internal/platform/process"
)

func TestAHumanWordRestartsAClaimOfAMemberThatCannotTakeMessagesMidRun(t *testing.T) {
	binary := filepath.Join(t.TempDir(), "command.exe")
	if out, err := process.Command(t.Context(), "", "go", "build", "-o", binary, "./worker/command/testdata/fakecommand").CombinedOutput(); err != nil {
		t.Fatalf("build: %s %v", out, err)
	}
	ctx, cancel := context.WithTimeout(t.Context(), 30*time.Second)
	defer cancel()
	dir := integrationRepository(t)
	var leaderCalls atomic.Int32
	leaderModel := groupScript{name: "leader", test: t, reply: func(model.Request) fake.Reply { leaderCalls.Add(1); return fake.Reply{Text: "Noted."} }}
	e, err := engine.New(engine.Deps{Workdir: dir, Providers: map[string]model.Provider{"leader": leaderModel}})
	if err != nil {
		t.Fatal(err)
	}
	defer e.Close()
	lead, work := agent.DefaultMerakCode(), agent.DefaultMerakCode()
	lead.ID, lead.Model.Provider = "leader-agent", "leader"
	work.ID, work.Mode = "worker-agent", permission.ModeTakeover
	work.Product = &agent.Product{Kind: worker.KindCommand, Binary: binary, Env: map[string]string{"MERAKCODE_FIXTURE_MODE": "hold-once"}}
	g, err := createGroup(t, e, ctx, group.Group{Kind: group.KindLocal, Name: "Restart", Project: group.Project{Directory: dir}, Leader: "leader"}, []group.Member{
		{ID: "owner", Name: "Owner", Kind: group.MemberHuman, Role: group.RoleOwner},
		{ID: "leader", Name: "Leader", Kind: group.MemberAgent, AgentRole: group.AgentLeader, Agent: lead.ID},
		{ID: "worker", Name: "Worker", Kind: group.MemberAgent, AgentRole: group.AgentWorker, Agent: work.ID},
	}, []agent.Agent{lead, work})
	if err != nil {
		t.Fatal(err)
	}
	card, err := e.CreateAssignedTask(ctx, task.Card{Group: g.ID, Title: "Restyle", Workspace: workspace.KindInplace, Areas: []string{"."}, CreatedBy: event.Actor{Kind: event.ActorHuman, ID: "owner"}}, "worker")
	if err != nil {
		t.Fatal(err)
	}
	waitFor(t, ctx, "the first run to start", func() bool { _, err := os.Stat(filepath.Join(dir, "started.flag")); return err == nil })
	claim := card.Claims[0].ID
	calls := leaderCalls.Load()
	if _, err := e.SayGroup(ctx, g.ID, "", "owner", group.Message{To: []event.ID{"worker"}, Text: "Use the blue theme"}); err != nil {
		t.Fatal(err)
	}
	waitFor(t, ctx, "the claim to report after the restart", func() bool {
		current, err := e.Tasks.Get(ctx, card.ID)
		return err == nil && len(current.Claims) == 1 && current.Claims[0].Status == task.ClaimReported
	})
	current, err := e.Tasks.Get(ctx, card.ID)
	if err != nil || current.Claims[0].ID != claim {
		t.Fatalf("the restart created another claim: %+v %v", current.Claims, err)
	}
	input, err := os.ReadFile(filepath.Join(dir, "input.txt"))
	if err != nil || !strings.Contains(string(input), "Message from Owner (a human; this overrides the Leader's instructions): Use the blue theme") {
		t.Fatalf("the restarted run read %q, %v", input, err)
	}
	waitFor(t, ctx, "the Leader to be woken", func() bool { return leaderCalls.Load() > calls })
}

func waitFor(t *testing.T, ctx context.Context, what string, ok func() bool) {
	t.Helper()
	for !ok() {
		select {
		case <-time.After(5 * time.Millisecond):
		case <-ctx.Done():
			t.Fatalf("timed out waiting for %s", what)
		}
	}
}

func TestEveryInputDeliveredToARunningMemberIsReceiptedAndLaterConsumed(t *testing.T) {
	ctx, cancel := context.WithTimeout(t.Context(), 10*time.Second)
	defer cancel()
	started := make(chan struct{})
	finish := make(chan struct{})
	report := integrationCall("submit_report", map[string]any{"verdict": "done", "summary": "Verified."})
	report.Hold = finish
	workerModel := fake.New(t, fake.Reply{Hold: make(chan struct{}), Expect: func(model.Request) error { close(started); return nil }}, report)
	leaderModel := groupScript{name: "leader", test: t, reply: func(model.Request) fake.Reply { return fake.Reply{Text: "Noted."} }}
	dir := t.TempDir()
	e, err := engine.New(engine.Deps{Workdir: dir, Providers: map[string]model.Provider{"leader": leaderModel, "worker": workerModel}})
	if err != nil {
		t.Fatal(err)
	}
	defer e.Close()
	lead, work := agent.DefaultMerakCode(), agent.DefaultMerakCode()
	lead.ID, lead.Model.Provider = "leader-agent", "leader"
	work.ID, work.Model.Provider = "worker-agent", "worker"
	g, err := createGroup(t, e, ctx, group.Group{Kind: group.KindLocal, Name: "Receipts", Project: group.Project{Directory: dir}, Leader: "leader"}, []group.Member{
		{ID: "owner", Name: "Owner", Kind: group.MemberHuman, Role: group.RoleOwner},
		{ID: "leader", Name: "Leader", Kind: group.MemberAgent, AgentRole: group.AgentLeader, Agent: lead.ID},
		{ID: "worker", Name: "Worker", Kind: group.MemberAgent, AgentRole: group.AgentWorker, Agent: work.ID},
	}, []agent.Agent{lead, work})
	if err != nil {
		t.Fatal(err)
	}
	facts, stop := e.Bus.Subscribe(event.Filter{Scope: event.Scope{Group: g.ID}, Types: []event.Type{loop.InputDelivered, loop.InputConsumed}})
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
	first := integrationCall("todo_write", map[string]any{"items": []map[string]string{{"content": "Read", "status": "in_progress"}, {"content": "Write", "status": "pending"}}})
	second := integrationCall("todo_write", map[string]any{"items": []map[string]string{{"content": "Read", "status": "done"}, {"content": "Write", "status": "in_progress"}}})
	e, err := engine.New(engine.Deps{Workdir: t.TempDir(), Providers: map[string]model.Provider{"fake": fake.New(t, first, second, fake.Reply{Text: "Done."})}})
	if err != nil {
		t.Fatal(err)
	}
	defer e.Close()
	id, err := e.CreateSession(ctx, engine.SessionOptions{Provider: "fake", Workdir: t.TempDir()})
	if err != nil {
		t.Fatal(err)
	}
	facts, stop := e.Bus.Subscribe(event.Filter{Types: []event.Type{session.TodoUpdated}})
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
	waitFor(t, ctx, "the snapshot to settle", func() bool {
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
	e, err := engine.New(engine.Deps{Workdir: dir, Providers: map[string]model.Provider{
		"leader": groupScript{name: "leader", test: t, reply: has("leader")},
		"worker": groupScript{name: "worker", test: t, reply: has("worker")},
	}})
	if err != nil {
		t.Fatal(err)
	}
	defer e.Close()
	lead, work := agent.DefaultMerakCode(), agent.DefaultMerakCode()
	lead.ID, lead.Model.Provider = "leader-agent", "leader"
	work.ID, work.Model.Provider = "worker-agent", "worker"
	g, err := createGroup(t, e, ctx, group.Group{Kind: group.KindLocal, Name: "Todos", Project: group.Project{Directory: dir}, Leader: "leader"}, []group.Member{
		{ID: "owner", Name: "Owner", Kind: group.MemberHuman, Role: group.RoleOwner},
		{ID: "leader", Name: "Leader", Kind: group.MemberAgent, AgentRole: group.AgentLeader, Agent: lead.ID},
		{ID: "worker", Name: "Worker", Kind: group.MemberAgent, AgentRole: group.AgentWorker, Agent: work.ID},
	}, []agent.Agent{lead, work})
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
