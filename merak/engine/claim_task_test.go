package engine_test

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
	"github.com/TongTong313/merakcode/merak/engine/agent"
	"github.com/TongTong313/merakcode/merak/engine/event"
	"github.com/TongTong313/merakcode/merak/engine/group"
	"github.com/TongTong313/merakcode/merak/engine/model"
	"github.com/TongTong313/merakcode/merak/engine/model/fake"
	"github.com/TongTong313/merakcode/merak/engine/permission"
	"github.com/TongTong313/merakcode/merak/engine/store"
	"github.com/TongTong313/merakcode/merak/engine/task"
	"github.com/TongTong313/merakcode/merak/engine/worker"
	"github.com/TongTong313/merakcode/merak/engine/workspace"
	"github.com/TongTong313/merakcode/merak/internal/platform/process"
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
	leaderModel := groupScript{name: "leader", test: t, reply: func(req model.Request) fake.Reply { log.add(req); return reply(req) }}
	dir := t.TempDir()
	e, err := engine.New(engine.Deps{Workdir: dir, Providers: map[string]model.Provider{"leader": leaderModel, "worker": workerModel}})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { e.Close() })
	lead, work := agent.DefaultMerakCode(), agent.DefaultMerakCode()
	lead.ID, lead.Model.Provider = "leader-agent", "leader"
	work.ID, work.Model.Provider = "worker-agent", "worker"
	g, err := createGroup(t, e, ctx, group.Group{Kind: group.KindLocal, Name: "Claims", Project: group.Project{Directory: dir}, Leader: "leader"}, []group.Member{
		{ID: "owner", Name: "Owner", Kind: group.MemberHuman, Role: group.RoleOwner},
		{ID: "leader", Name: "Leader", Kind: group.MemberAgent, AgentRole: group.AgentLeader, Agent: lead.ID},
		{ID: "worker", Name: "Worker", Kind: group.MemberAgent, AgentRole: group.AgentWorker, Agent: work.ID},
	}, []agent.Agent{lead, work})
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
	report := integrationCall("submit_report", map[string]any{"verdict": "done", "summary": "Finished the first task."})
	report.Hold = finish
	workerModel := groupScript{name: "worker", test: t, reply: func() func(model.Request) fake.Reply {
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
				return integrationCall("claim_task", map[string]any{"task": open.ID})
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
	waitFor(t, r.ctx, "the claim on the open task", func() bool {
		card, err := r.e.Tasks.Get(r.ctx, open.ID)
		return err == nil && len(card.Claims) == 1
	})
	card, _ := r.e.Tasks.Get(r.ctx, open.ID)
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
	waitFor(t, r.ctx, "the Leader to hear about the claim", func() bool { return r.leaders.saw("(task.queued)") })
	close(finish)
}

func TestAWorkerSeesTheUnclaimedTasksOfItsGroupAfterItsReportAndOnlyThen(t *testing.T) {
	t.Run("with an unclaimed task", func(t *testing.T) {
		var sawList atomic.Bool
		started, release := make(chan struct{}, 1), make(chan struct{})
		var open atomic.Value
		workerModel := groupScript{name: "worker", test: t, reply: func() func(model.Request) fake.Reply {
			var calls int
			return func(req model.Request) fake.Reply {
				calls++
				switch calls {
				case 1:
					started <- struct{}{}
					reply := integrationCall("submit_report", map[string]any{"verdict": "done", "summary": "First done."})
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
					return integrationCall("claim_task", map[string]any{"task": found[1]})
				}
				return fake.Reply{Text: "Done."}
			}
		}()}
		r := newClaimRig(t, workerModel, leaderThatMakesATask("Unassigned work"))
		r.assigned(t, "First work")
		<-started
		r.leaderMakes(t, "Unassigned work")
		close(release)
		waitFor(t, r.ctx, "the Worker to claim the task", func() bool {
			id, _ := open.Load().(string)
			if id == "" {
				return false
			}
			card, err := r.e.Tasks.Get(r.ctx, event.ID(id))
			return err == nil && len(card.Claims) == 1 && card.Claims[0].Member == "worker"
		})
		if !sawList.Load() {
			t.Fatal("the Worker was not shown the unclaimed task")
		}
	})
	t.Run("with nothing to claim the Worker does not run another turn", func(t *testing.T) {
		workerModel := fake.New(t, integrationCall("submit_report", map[string]any{"verdict": "done", "summary": "Only done."}))
		r := newClaimRig(t, workerModel)
		card := r.assigned(t, "Only work")
		waitFor(t, r.ctx, "the report", func() bool {
			current, err := r.e.Tasks.Get(r.ctx, card.ID)
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
	waitFor(t, r.ctx, "the Leader's task", func() bool {
		cards, err := r.e.Tasks.List(r.ctx, r.g.ID)
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
			return integrationCall("create_task", map[string]any{"title": title, "workspace": "none"})
		}
		return fake.Reply{Text: "Observed."}
	}
}

func TestIdleWorkersAreInvitedOnceToATaskTheLeaderLeftUnassigned(t *testing.T) {
	invited := make(chan model.Request, 4)
	var mu sync.Mutex
	var calls int
	var open event.ID
	workerModel := groupScript{name: "worker", test: t, reply: func(req model.Request) fake.Reply {
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
			open = event.ID(found[1])
			return integrationCall("claim_task", map[string]any{"task": found[1]})
		case 2:
			return fake.Reply{Text: "Claimed it."}
		case 3:
			return integrationCall("submit_report", map[string]any{"verdict": "done", "summary": "Did the open work."})
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
	waitFor(t, r.ctx, "the invited Worker to report", func() bool {
		mu.Lock()
		id := open
		mu.Unlock()
		if id == "" {
			return false
		}
		card, err := r.e.Tasks.Get(r.ctx, id)
		return err == nil && len(card.Claims) == 1 && card.Claims[0].Status == task.ClaimReported
	})
	offers, err := r.e.FindEvents(r.ctx, store.Query{Scope: event.Scope{Group: r.g.ID}, Types: []event.Type{task.Offered}})
	if err != nil || len(offers) != 1 {
		t.Fatalf("offers=%+v err=%v", offers, err)
	}
}

func TestAnOfferIsNeverRepeatedForTheSameTaskAndWorker(t *testing.T) {
	invitations := make(chan struct{}, 8)
	workerModel := groupScript{name: "worker", test: t, reply: func(model.Request) fake.Reply {
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
		waitFor(t, r.ctx, "the Leader to answer", func() bool { return r.leaders.saw("Any news?") })
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
	for _, build := range []struct{ path, source string }{{claude, "./worker/claudecode/testdata/fakeclaude"}, {merak, "../cmd/merak"}} {
		if out, err := process.Command(ctx, "", "go", "build", "-o", build.path, build.source).CombinedOutput(); err != nil {
			t.Fatalf("build: %s %v", out, err)
		}
	}
	idFile := filepath.Join(bin, "claim.txt")
	directory := t.TempDir()
	log := new(leaderLog)
	leaderModel := groupScript{name: "leader", test: t, reply: func(req model.Request) fake.Reply { log.add(req); return fake.Reply{Text: "Observed."} }}
	e, err := engine.New(engine.Deps{MCPCommand: merak, Workdir: directory, Providers: map[string]model.Provider{"leader": leaderModel}})
	if err != nil {
		t.Fatal(err)
	}
	defer e.Close()
	lead, work := agent.DefaultMerakCode(), agent.DefaultMerakCode()
	lead.ID, lead.Model.Provider = "lead-agent", "leader"
	work.ID, work.Mode = "work-agent", permission.ModeAsk
	work.Product = &agent.Product{Kind: worker.KindClaudeCode, Binary: claude, Args: []string{"--mcp-report", "--mcp-claim-file", idFile}, Env: map[string]string{"MERAKCODE_FIXTURE_MCP": "1", "MERAKCODE_FIXTURE_APPROVAL": "never"}}
	g, err := createGroup(t, e, ctx, group.Group{Kind: group.KindLocal, Name: "External claims", Project: group.Project{Directory: directory}, Leader: "leader"}, []group.Member{
		{ID: "leader", Name: "Leader", Kind: group.MemberAgent, AgentRole: group.AgentLeader, Agent: lead.ID},
		{ID: "worker", Name: "Worker", Kind: group.MemberAgent, AgentRole: group.AgentWorker, Agent: work.ID},
		{ID: "owner", Name: "Owner", Kind: group.MemberHuman, Role: group.RoleOwner},
	}, []agent.Agent{lead, work})
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
	waitFor(t, ctx, "the external Worker's claim", func() bool {
		card, err := e.Tasks.Get(ctx, open.ID)
		return err == nil && len(card.Claims) >= 1 && card.Claims[0].Member == "worker"
	})
	queued, err := e.FindEvents(ctx, store.Query{Scope: event.Scope{Group: g.ID, Task: open.ID}, Types: []event.Type{task.QueuedEvent}})
	if err != nil || len(queued) == 0 || queued[0].Actor.ID != "worker" {
		t.Fatalf("the claim is not attributed to the Worker: %+v %v", queued, err)
	}
}
