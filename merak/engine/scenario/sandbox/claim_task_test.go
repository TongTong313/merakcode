package sandbox_test

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"regexp"
	"slices"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/TongTong313/merakcode/merak/engine"
	"github.com/TongTong313/merakcode/merak/engine/agent/definition"
	"github.com/TongTong313/merakcode/merak/engine/agent/model"
	"github.com/TongTong313/merakcode/merak/engine/agent/model/fake"
	"github.com/TongTong313/merakcode/merak/engine/agent/permission"
	"github.com/TongTong313/merakcode/merak/engine/collab/group"
	"github.com/TongTong313/merakcode/merak/engine/collab/task"
	"github.com/TongTong313/merakcode/merak/engine/collab/workspace"
	"github.com/TongTong313/merakcode/merak/engine/infra/event"
	"github.com/TongTong313/merakcode/merak/engine/infra/process"
	"github.com/TongTong313/merakcode/merak/engine/infra/store"
	"github.com/TongTong313/merakcode/merak/testkit/enginetest"
)

// claimRig is a group with a Leader that only observes and one built-in Worker.
type claimRig struct {
	e       *engine.Engine
	g       group.Group
	ctx     context.Context
	leaders *leaderLog
}

// leaderLog keeps every request the Leader's model received.
type leaderLog struct {
	mu       sync.Mutex
	requests []string
}

func (l *leaderLog) add(req model.Request) {
	body, _ := json.Marshal(req.Messages)
	l.mu.Lock()
	l.requests = append(l.requests, string(body))
	l.mu.Unlock()
}

func (l *leaderLog) saw(text string) bool {
	l.mu.Lock()
	defer l.mu.Unlock()
	for _, request := range l.requests {
		if strings.Contains(request, text) {
			return true
		}
	}
	return false
}

func newClaimRig(t *testing.T, workerModel model.Provider, leaderReply ...func(model.Request) fake.Reply) *claimRig {
	t.Helper()
	ctx, cancel := context.WithTimeout(t.Context(), 15*time.Second)
	t.Cleanup(cancel)
	log := new(leaderLog)
	reply := func(model.Request) fake.Reply { return fake.Reply{Text: "Observed."} }
	if len(leaderReply) > 0 {
		reply = leaderReply[0]
	}
	leaderModel := enginetest.GroupScript{ProviderName: "leader", Test: t, Reply: func(req model.Request) fake.Reply { log.add(req); return reply(req) }}
	dir := t.TempDir()
	deps := enginetest.Deps(t)
	deps.Workdir = dir
	deps.Providers = map[string]model.Provider{"leader": leaderModel, "worker": workerModel}
	e, err := engine.New(deps)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { e.Close() })
	lead, work := definition.DefaultMerakCode(), definition.DefaultMerakCode()
	lead.ID, lead.Model.Provider = "leader-agent", "leader"
	work.ID, work.Model.Provider = "worker-agent", "worker"
	g, err := enginetest.CreateGroup(t, e, ctx, group.Group{Kind: group.KindLocal, Name: "Claims", Project: group.Project{Directory: dir}, Leader: "leader"}, []group.Member{
		{ID: "owner", Name: "Owner", Kind: group.MemberHuman, Role: group.RoleOwner},
		{ID: "leader", Name: "Leader", Kind: group.MemberAgent, AgentRole: group.AgentLeader, Agent: lead.ID},
		{ID: "worker", Name: "Worker", Kind: group.MemberAgent, AgentRole: group.AgentWorker, Agent: work.ID},
	}, []definition.Agent{lead, work})
	if err != nil {
		t.Fatal(err)
	}
	return &claimRig{e: e, g: g, ctx: ctx, leaders: log}
}

func (r *claimRig) human(t *testing.T, title string) task.Card {
	t.Helper()
	card, err := r.e.CreateTask(r.ctx, task.Card{Group: r.g.ID, Title: title, Workspace: workspace.KindNone, CreatedBy: event.Actor{Kind: event.ActorHuman, ID: "owner"}})
	if err != nil {
		t.Fatal(err)
	}
	return card
}

func (r *claimRig) assigned(t *testing.T, title string) task.Card {
	t.Helper()
	card, err := r.e.CreateAssignedTask(r.ctx, task.Card{Group: r.g.ID, Title: title, Workspace: workspace.KindNone, CreatedBy: event.Actor{Kind: event.ActorHuman, ID: "owner"}}, "worker")
	if err != nil {
		t.Fatal(err)
	}
	return card
}

func TestABusyWorkerClaimsAnOpenTaskOfItsGroupAndTheLeaderIsTold(t *testing.T) {
	var open task.Card
	finish := make(chan struct{})
	started := make(chan struct{})
	report := enginetest.IntegrationCall("submit_report", map[string]any{"verdict": "done", "summary": "Finished the first task."})
	report.Hold = finish
	workerModel := enginetest.GroupScript{ProviderName: "worker", Test: t, Reply: func() func(model.Request) fake.Reply {
		var calls int
		return func(model.Request) fake.Reply {
			calls++
			switch calls {
			case 1:
				select {
				case <-started:
				default:
					close(started)
				}
				return enginetest.IntegrationCall("claim_task", map[string]any{"task": open.ID})
			case 2:
				return report
			}
			return fake.Reply{Text: "Done."}
		}
	}()}
	r := newClaimRig(t, workerModel)
	open = r.human(t, "Open work")
	r.assigned(t, "First work")
	<-started
	enginetest.WaitFor(t, r.ctx, "the claim on the open task", func() bool {
		card, err := r.e.Task(r.ctx, open.ID)
		return err == nil && len(card.Claims) == 1
	})
	card, _ := r.e.Task(r.ctx, open.ID)
	if card.Claims[0].Member != "worker" || card.Claims[0].Role != task.RoleOwner || card.Claims[0].Status != task.ClaimQueued {
		t.Fatalf("claims=%+v: a busy worker's claim queues behind its running one", card.Claims)
	}
	queued, err := r.e.FindEvents(r.ctx, store.Query{Scope: event.Scope{Group: r.g.ID}, Types: []event.Type{task.QueuedEvent}})
	if err != nil {
		t.Fatal(err)
	}
	var byWorker bool
	for _, fact := range queued {
		byWorker = byWorker || fact.Scope.Task == open.ID && fact.Actor.Kind == event.ActorAgent && fact.Actor.ID == "worker"
	}
	if !byWorker {
		t.Fatalf("the claim was not initiated by the worker itself: %+v", queued)
	}
	enginetest.WaitFor(t, r.ctx, "the Leader to hear about the claim", func() bool { return r.leaders.saw("(task.queued)") })
	close(finish)
}

func TestAWorkerSeesTheUnclaimedTasksOfItsGroupAfterItsReportAndOnlyThen(t *testing.T) {
	t.Run("with an unclaimed task", func(t *testing.T) {
		var sawList atomic.Bool
		started, release := make(chan struct{}, 1), make(chan struct{})
		var open atomic.Value
		workerModel := enginetest.GroupScript{ProviderName: "worker", Test: t, Reply: func() func(model.Request) fake.Reply {
			var calls int
			return func(req model.Request) fake.Reply {
				calls++
				switch calls {
				case 1:
					started <- struct{}{}
					reply := enginetest.IntegrationCall("submit_report", map[string]any{"verdict": "done", "summary": "First done."})
					reply.Hold = release
					return reply
				case 2:
					var text strings.Builder
					for _, part := range req.Messages[len(req.Messages)-1].Parts {
						text.WriteString(part.Text)
					}
					found := taskLine.FindStringSubmatch(text.String())
					if found == nil || !strings.Contains(text.String(), "Unclaimed work") {
						return fake.Reply{Text: "Nothing."}
					}
					sawList.Store(true)
					open.Store(found[1])
					return enginetest.IntegrationCall("claim_task", map[string]any{"task": found[1]})
				}
				return fake.Reply{Text: "Done."}
			}
		}()}
		r := newClaimRig(t, workerModel, leaderThatMakesATask("Unassigned work"))
		r.assigned(t, "First work")
		<-started
		r.leaderMakes(t, "Unassigned work")
		close(release)
		enginetest.WaitFor(t, r.ctx, "the Worker to claim the task", func() bool {
			id, _ := open.Load().(string)
			if id == "" {
				return false
			}
			card, err := r.e.Task(r.ctx, event.ID(id))
			return err == nil && len(card.Claims) == 1 && card.Claims[0].Member == "worker"
		})
		if !sawList.Load() {
			t.Fatal("the Worker was not shown the unclaimed task")
		}
	})
	t.Run("with nothing to claim the Worker does not run another turn", func(t *testing.T) {
		workerModel := fake.New(t, enginetest.IntegrationCall("submit_report", map[string]any{"verdict": "done", "summary": "Only done."}))
		r := newClaimRig(t, workerModel)
		card := r.assigned(t, "Only work")
		enginetest.WaitFor(t, r.ctx, "the report", func() bool {
			current, err := r.e.Task(r.ctx, card.ID)
			return err == nil && len(current.Claims) == 1 && current.Claims[0].Status == task.ClaimReported
		})
		time.Sleep(300 * time.Millisecond) // an extra turn would exhaust the script and fail the test
	})
}

var taskLine = regexp.MustCompile(`- (\w+): Unassigned work`)

// leaderMakes makes the rig's Leader create one unassigned task, titled title, when a human asks "Make the task".
func (r *claimRig) leaderMakes(t *testing.T, title string) {
	t.Helper()
	if _, err := r.e.SayGroup(r.ctx, r.g.ID, "", "owner", group.Message{Text: "Make the task"}); err != nil {
		t.Fatal(err)
	}
	enginetest.WaitFor(t, r.ctx, "the Leader's task", func() bool {
		cards, err := r.e.GroupTasks(r.ctx, r.g.ID)
		return err == nil && slices.ContainsFunc(cards, func(card task.Card) bool { return card.Title == title })
	})
}

func leaderThatMakesATask(title string) func(model.Request) fake.Reply {
	var made atomic.Bool
	return func(req model.Request) fake.Reply {
		last := req.Messages[len(req.Messages)-1]
		var text strings.Builder
		for _, part := range last.Parts {
			text.WriteString(part.Text)
		}
		if strings.Contains(text.String(), "Make the task") && made.CompareAndSwap(false, true) {
			return enginetest.IntegrationCall("create_task", map[string]any{"title": title, "workspace": "none"})
		}
		return fake.Reply{Text: "Observed."}
	}
}

func TestIdleWorkersAreInvitedOnceToATaskTheLeaderLeftUnassigned(t *testing.T) {
	invited := make(chan model.Request, 4)
	var mu sync.Mutex
	var calls int
	var open event.ID
	workerModel := enginetest.GroupScript{ProviderName: "worker", Test: t, Reply: func(req model.Request) fake.Reply {
		mu.Lock()
		calls++
		n := calls
		mu.Unlock()
		switch n {
		case 1:
			invited <- req
			var text strings.Builder
			for _, part := range req.Messages[len(req.Messages)-1].Parts {
				text.WriteString(part.Text)
			}
			found := taskLine.FindStringSubmatch(text.String())
			if found == nil {
				t.Errorf("no task in the invitation: %s", text.String())
				return fake.Reply{Text: "Passing."}
			}
			mu.Lock()
			open = event.ID(found[1])
			mu.Unlock()
			return enginetest.IntegrationCall("claim_task", map[string]any{"task": found[1]})
		case 2:
			return fake.Reply{Text: "Claimed it."}
		case 3:
			return enginetest.IntegrationCall("submit_report", map[string]any{"verdict": "done", "summary": "Did the open work."})
		}
		return fake.Reply{Text: "Nothing else."}
	}}
	r := newClaimRig(t, workerModel, leaderThatMakesATask("Unassigned work"))
	r.leaderMakes(t, "Unassigned work")
	var req model.Request
	select {
	case req = <-invited:
	case <-r.ctx.Done():
		t.Fatal("the idle Worker was never invited")
	}
	var names []string
	for _, spec := range req.Tools {
		names = append(names, spec.Name)
	}
	if !strings.Contains(strings.Join(names, " "), "claim_task") || strings.Contains(strings.Join(names, " "), "write_file") || strings.Contains(strings.Join(names, " "), "bash") {
		t.Fatalf("an invitation turn offers claim_task and read-only tools, got %v", names)
	}
	enginetest.WaitFor(t, r.ctx, "the invited Worker to report", func() bool {
		mu.Lock()
		id := open
		mu.Unlock()
		if id == "" {
			return false
		}
		card, err := r.e.Task(r.ctx, id)
		return err == nil && len(card.Claims) == 1 && card.Claims[0].Status == task.ClaimReported
	})
	offers, err := r.e.FindEvents(r.ctx, store.Query{Scope: event.Scope{Group: r.g.ID}, Types: []event.Type{task.Offered}})
	if err != nil || len(offers) != 1 {
		t.Fatalf("offers=%+v err=%v", offers, err)
	}
}

func TestAnOfferIsNeverRepeatedForTheSameTaskAndWorker(t *testing.T) {
	invitations := make(chan struct{}, 8)
	workerModel := enginetest.GroupScript{ProviderName: "worker", Test: t, Reply: func(model.Request) fake.Reply {
		invitations <- struct{}{}
		return fake.Reply{Text: "Passing."}
	}}
	r := newClaimRig(t, workerModel, leaderThatMakesATask("Unassigned work"))
	r.leaderMakes(t, "Unassigned work")
	select {
	case <-invitations:
	case <-r.ctx.Done():
		t.Fatal("the idle Worker was never invited")
	}
	for range 2 { // more Leader turns must not invite again
		if _, err := r.e.SayGroup(r.ctx, r.g.ID, "", "owner", group.Message{Text: "Any news?"}); err != nil {
			t.Fatal(err)
		}
		enginetest.WaitFor(t, r.ctx, "the Leader to answer", func() bool { return r.leaders.saw("Any news?") })
		time.Sleep(200 * time.Millisecond)
	}
	if len(invitations) != 0 {
		t.Fatalf("the Worker was invited again: %d more", len(invitations))
	}
}

func TestAnExternalWorkerClaimsATaskThroughItsMCPTools(t *testing.T) {
	ctx, cancel := context.WithTimeout(t.Context(), 40*time.Second)
	defer cancel()
	bin := t.TempDir()
	claude, merak := filepath.Join(bin, "claude.exe"), filepath.Join(bin, "merak.exe")
	for _, build := range []struct{ path, source string }{{claude, "github.com/TongTong313/merakcode/merak/engine/collab/worker/claudecode/testdata/fakeclaude"}, {merak, "github.com/TongTong313/merakcode/merak/cmd/merak"}} {
		if out, err := process.Command(ctx, "", "go", "build", "-o", build.path, build.source).CombinedOutput(); err != nil {
			t.Fatalf("build: %s %v", out, err)
		}
	}
	idFile := filepath.Join(bin, "claim.txt")
	directory := t.TempDir()
	log := new(leaderLog)
	leaderModel := enginetest.GroupScript{ProviderName: "leader", Test: t, Reply: func(req model.Request) fake.Reply { log.add(req); return fake.Reply{Text: "Observed."} }}
	deps2 := enginetest.Deps(t)
	deps2.MCPCommand = merak
	deps2.Workdir = directory
	deps2.Providers = map[string]model.Provider{"leader": leaderModel}
	e, err := engine.New(deps2)
	if err != nil {
		t.Fatal(err)
	}
	defer e.Close()
	lead, work := definition.DefaultMerakCode(), definition.DefaultMerakCode()
	lead.ID, lead.Model.Provider = "lead-agent", "leader"
	work.ID, work.Mode = "work-agent", permission.ModeAsk
	work.Product = &definition.Product{Kind: definition.KindClaudeCode, Binary: claude, Args: []string{"--mcp-report", "--mcp-claim-file", idFile}, Env: map[string]string{"MERAKCODE_FIXTURE_MCP": "1", "MERAKCODE_FIXTURE_APPROVAL": "never"}}
	g, err := enginetest.CreateGroup(t, e, ctx, group.Group{Kind: group.KindLocal, Name: "External claims", Project: group.Project{Directory: directory}, Leader: "leader"}, []group.Member{
		{ID: "leader", Name: "Leader", Kind: group.MemberAgent, AgentRole: group.AgentLeader, Agent: lead.ID},
		{ID: "worker", Name: "Worker", Kind: group.MemberAgent, AgentRole: group.AgentWorker, Agent: work.ID},
		{ID: "owner", Name: "Owner", Kind: group.MemberHuman, Role: group.RoleOwner},
	}, []definition.Agent{lead, work})
	if err != nil {
		t.Fatal(err)
	}
	open, err := e.CreateTask(ctx, task.Card{Group: g.ID, Title: "Open for claiming", Workspace: workspace.KindNone, CreatedBy: event.Actor{Kind: event.ActorHuman, ID: "owner"}})
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(idFile, []byte(open.ID), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := e.CreateAssignedTask(ctx, task.Card{Group: g.ID, Title: "Use MCP", Workspace: "inplace", CreatedBy: event.Actor{Kind: event.ActorHuman, ID: "owner"}}, "worker"); err != nil {
		t.Fatal(err)
	}
	enginetest.WaitFor(t, ctx, "the external Worker's claim", func() bool {
		card, err := e.Task(ctx, open.ID)
		return err == nil && len(card.Claims) >= 1 && card.Claims[0].Member == "worker"
	})
	queued, err := e.FindEvents(ctx, store.Query{Scope: event.Scope{Group: g.ID, Task: open.ID}, Types: []event.Type{task.QueuedEvent}})
	if err != nil || len(queued) == 0 || queued[0].Actor.ID != "worker" {
		t.Fatalf("the claim is not attributed to the Worker: %+v %v", queued, err)
	}
}
