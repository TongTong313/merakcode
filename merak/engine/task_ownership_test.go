package engine_test

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"slices"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/TongTong313/merakcode/merak/engine"
	"github.com/TongTong313/merakcode/merak/engine/agent"
	"github.com/TongTong313/merakcode/merak/engine/event"
	"github.com/TongTong313/merakcode/merak/engine/group"
	"github.com/TongTong313/merakcode/merak/engine/leader"
	"github.com/TongTong313/merakcode/merak/engine/loop"
	"github.com/TongTong313/merakcode/merak/engine/model"
	"github.com/TongTong313/merakcode/merak/engine/model/fake"
	"github.com/TongTong313/merakcode/merak/engine/store"
	"github.com/TongTong313/merakcode/merak/engine/store/memory"
	"github.com/TongTong313/merakcode/merak/engine/task"
	"github.com/TongTong313/merakcode/merak/internal/testcloud"
	"github.com/TongTong313/merakcode/merak/protocol"
)

// ownership is an engine with one local group whose Leader records every request it receives.
type ownership struct {
	t        *testing.T
	ctx      context.Context
	e        *engine.Engine
	dir      string
	group    group.Group
	requests chan model.Request
	skew     atomic.Int64
}

// advance moves the clock of the engine forward.
func (o *ownership) advance(by time.Duration) { o.skew.Add(int64(by)) }

var humanActor = event.Actor{Kind: event.ActorHuman, ID: "human"}

func newOwnership(t *testing.T) *ownership {
	t.Helper()
	ctx, cancel := context.WithTimeout(t.Context(), 15*time.Second)
	t.Cleanup(cancel)
	o := &ownership{t: t, ctx: ctx, dir: t.TempDir(), requests: make(chan model.Request, 32)}
	provider := groupScript{name: "leader-model", test: t, reply: func(req model.Request) fake.Reply {
		o.requests <- req
		return fake.Reply{Text: "Noted."}
	}}
	e, err := engine.New(engine.Deps{Workdir: o.dir, Now: func() time.Time { return time.Now().Add(time.Duration(o.skew.Load())) }, Providers: map[string]model.Provider{"leader-model": provider, "worker-model": fake.New(t, fake.Reply{Hold: make(chan struct{})})}})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { e.Close() })
	o.e = e
	lead, work := agent.DefaultLeader(), agent.DefaultWorker()
	lead.ID, lead.Model.Provider = "leader-agent", "leader-model"
	work.ID, work.Model.Provider = "worker-agent", "worker-model"
	o.group, err = createGroup(t, e, ctx, group.Group{Kind: group.KindLocal, Name: "Team", Project: group.Project{Directory: o.dir}, Leader: "leader"}, []group.Member{
		{ID: "human", Name: "Owner", Kind: group.MemberHuman, Role: group.RoleOwner},
		{ID: "leader", Name: "Leader", Kind: group.MemberAgent, AgentRole: group.AgentLeader, Agent: lead.ID, Owner: "human"},
		{ID: "worker", Name: "Worker", Kind: group.MemberAgent, AgentRole: group.AgentWorker, Agent: work.ID, Owner: "human"},
	}, []agent.Agent{lead, work})
	if err != nil {
		t.Fatal(err)
	}
	return o
}

// quiet fails the test when the Leader receives a request within the wait.
func (o *ownership) quiet(wait time.Duration) {
	o.t.Helper()
	select {
	case req := <-o.requests:
		o.t.Fatalf("the Leader was woken: %.200s", fmt.Sprint(req.Messages))
	case <-time.After(wait):
	}
}

// woken returns the request that the Leader receives next.
func (o *ownership) woken() model.Request {
	o.t.Helper()
	select {
	case req := <-o.requests:
		return req
	case <-o.ctx.Done():
		o.t.Fatal("the Leader was not woken")
	}
	return model.Request{}
}

func TestATaskWithoutAGroupLivesInItsOwnStreamAndWakesNoLeader(t *testing.T) {
	o := newOwnership(t)
	card, err := o.e.CreateTask(o.ctx, task.Card{Title: "Solo", Project: o.dir, CreatedBy: humanActor})
	if err != nil {
		t.Fatal(err)
	}
	if card.Group != "" || card.Project != o.dir {
		t.Fatalf("card=%+v", card)
	}
	facts, err := o.e.FindEvents(o.ctx, store.Query{Scope: event.Scope{Task: card.ID}})
	if err != nil || len(facts) == 0 {
		t.Fatalf("facts=%d err=%v", len(facts), err)
	}
	for _, fact := range facts {
		if fact.Stream != event.Stream("task:"+card.ID) || fact.Scope.Group != "" {
			t.Fatalf("%s is in stream %q with scope %+v", fact.Type, fact.Stream, fact.Scope)
		}
	}
	o.quiet(300 * time.Millisecond)
	for _, missing := range []task.Card{{Title: "No project", CreatedBy: humanActor}, {Title: "Gone", Project: o.dir + "/missing", CreatedBy: humanActor}} {
		if _, err := o.e.CreateTask(o.ctx, missing); err == nil {
			t.Errorf("a task with project %q was created", missing.Project)
		}
	}
}

func errorCode(err error) string {
	var failure *engine.Error
	if errors.As(err, &failure) {
		return failure.Code
	}
	return ""
}

func (o *ownership) loose(title string) task.Card {
	o.t.Helper()
	card, err := o.e.CreateTask(o.ctx, task.Card{Title: title, Description: "Describe " + title, Project: o.dir, CreatedBy: humanActor})
	if err != nil {
		o.t.Fatal(err)
	}
	return card
}

func TestBindingATaskToAGroupWithTheSameWorkspaceWakesItsLeaderWithTheCard(t *testing.T) {
	o := newOwnership(t)
	card := o.loose("Solo")
	bound, err := o.e.BindTask(o.ctx, o.group.ID, card.ID, "human")
	if err != nil {
		t.Fatal(err)
	}
	if bound.Group != o.group.ID || bound.Project != o.dir {
		t.Fatalf("bound=%+v", bound)
	}
	if req := o.woken(); !strings.Contains(fmt.Sprint(req.Messages), string(card.ID)) {
		t.Fatalf("the first input of the Leader lacks the card: %.300s", fmt.Sprint(req.Messages))
	}
	facts, err := o.e.FindEvents(o.ctx, store.Query{Scope: event.Scope{Group: o.group.ID}, Types: []event.Type{task.Bound}})
	if err != nil || len(facts) != 1 || facts[0].Stream != event.Stream("group:"+o.group.ID) {
		t.Fatalf("bound facts=%v err=%v", facts, err)
	}
	if err := o.e.Tasks.SetPhase(o.ctx, card.ID, task.PhaseCancelled, humanActor); err != nil {
		t.Fatal(err)
	}
	later, err := o.e.FindEvents(o.ctx, store.Query{Scope: event.Scope{Task: card.ID}, Types: []event.Type{task.Closed}})
	if err != nil || len(later) == 0 || later[len(later)-1].Stream != event.Stream("group:"+o.group.ID) {
		t.Fatalf("after binding the events of the task are not in the stream of the group: %v %v", later, err)
	}
}

func TestATaskThatHasAGroupCannotBeBoundAgain(t *testing.T) {
	o := newOwnership(t)
	card := o.loose("Solo")
	if _, err := o.e.BindTask(o.ctx, o.group.ID, card.ID, "human"); err != nil {
		t.Fatal(err)
	}
	if _, err := o.e.BindTask(o.ctx, o.group.ID, card.ID, "human"); errorCode(err) != "MRK-6013" {
		t.Fatalf("binding twice: %v", err)
	}
}

func TestCloudGroupsTakeNoTaskYet(t *testing.T) {
	o := newOwnership(t)
	peer := testcloud.New(t)
	peer.Handle = func(req protocol.Message) (any, error) {
		return group.Group{ID: "cloud-group", Kind: group.KindCloud}, nil
	}
	if err := o.e.ConnectCloud(o.ctx, peer.Credentials()); err != nil {
		t.Fatal(err)
	}
	created, _ := json.Marshal(protocol.GroupCreateParams{Group: group.Group{Kind: group.KindCloud}, Members: []group.Member{{ID: "lead", Name: "Lead", Kind: group.MemberAgent, AgentRole: group.AgentLeader, Agent: "agent-1"}}})
	if _, handled, err := o.e.ForwardCloud(o.ctx, "group.create", created); err != nil || !handled {
		t.Fatalf("create handled=%t err=%v", handled, err)
	}
	loose := o.loose("Other")
	for method, params := range map[string]string{
		"group.bind":   fmt.Sprintf(`{"group":"cloud-group","task":%q}`, loose.ID),
		"group.create": fmt.Sprintf(`{"kind":"cloud","name":"Cloud","task":%q}`, loose.ID),
	} {
		if _, handled, err := o.e.ForwardCloud(o.ctx, method, json.RawMessage(params)); !handled || errorCode(err) != "MRK-6016" {
			t.Errorf("%s: handled=%t err=%v", method, handled, err)
		}
	}
}

// waitFor polls until the condition holds.
func (o *ownership) waitFor(what string, condition func() bool) {
	o.t.Helper()
	for o.ctx.Err() == nil {
		if condition() {
			return
		}
		time.Sleep(20 * time.Millisecond)
	}
	o.t.Fatalf("timed out waiting for %s", what)
}

// working creates a task in the group and waits until its Leader has seen it, so that the Leader has a thread.
func (o *ownership) working(title string) task.Card {
	o.t.Helper()
	card, err := o.e.CreateTask(o.ctx, task.Card{Group: o.group.ID, Title: title, Workspace: "none", CreatedBy: humanActor})
	if err != nil {
		o.t.Fatal(err)
	}
	o.woken()
	o.waitFor("the first turn of the Leader", func() bool {
		facts, _ := o.e.FindEvents(o.ctx, store.Query{Scope: event.Scope{Group: o.group.ID}, Types: []event.Type{loop.TurnFinished}})
		return len(facts) > 0
	})
	return card
}

func TestBindingATaskWithAnotherWorkspaceMovesTheIdleGroupAndItsOpenTasks(t *testing.T) {
	o := newOwnership(t)
	open := o.working("Open work")
	finished := o.working("Finished work")
	if err := o.e.Tasks.SetPhase(o.ctx, finished.ID, task.PhaseCancelled, humanActor); err != nil {
		t.Fatal(err)
	}
	other := t.TempDir()
	loose, err := o.e.CreateTask(o.ctx, task.Card{Title: "Elsewhere", Project: other, CreatedBy: humanActor})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := o.e.BindTask(o.ctx, o.group.ID, loose.ID, "human"); err != nil {
		t.Fatal(err)
	}
	state, err := o.e.Groups.Get(o.ctx, o.group.ID)
	if err != nil || state.Group.Project.Directory != other {
		t.Fatalf("group project=%q err=%v", state.Group.Project.Directory, err)
	}
	for id, want := range map[event.ID]string{open.ID: other, loose.ID: other, finished.ID: o.dir} {
		card, err := o.e.Tasks.Get(o.ctx, id)
		if err != nil || card.Project != want {
			t.Errorf("task %s project=%q want %q err=%v", id, card.Project, want, err)
		}
	}
	o.waitFor("the handover of the Leader to a new session", func() bool {
		facts, _ := o.e.FindEvents(o.ctx, store.Query{Scope: event.Scope{Group: o.group.ID}, Types: []event.Type{leader.ThreadHandedOver}})
		if len(facts) == 0 {
			return false
		}
		handover, err := event.Decode[leader.Handover](facts[len(facts)-1])
		return err == nil && handover.Leader == "leader" && handover.Session != handover.Previous
	})
}

func TestAGroupWithRunningWorkRefusesAnotherWorkspaceAndStaysAsItWas(t *testing.T) {
	o := newOwnership(t)
	running, err := o.e.CreateAssignedTask(o.ctx, task.Card{Group: o.group.ID, Title: "Busy", Workspace: "none", CreatedBy: humanActor}, "worker")
	if err != nil {
		t.Fatal(err)
	}
	o.waitFor("the claim to start", func() bool {
		card, err := o.e.Tasks.Get(o.ctx, running.ID)
		return err == nil && len(card.Claims) > 0 && card.Claims[0].Status == task.ClaimActive
	})
	loose, err := o.e.CreateTask(o.ctx, task.Card{Title: "Elsewhere", Project: t.TempDir(), CreatedBy: humanActor})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := o.e.BindTask(o.ctx, o.group.ID, loose.ID, "human"); errorCode(err) != "MRK-6014" {
		t.Fatalf("binding while work runs: %v", err)
	}
	state, err := o.e.Groups.Get(o.ctx, o.group.ID)
	card, getErr := o.e.Tasks.Get(o.ctx, loose.ID)
	if err != nil || getErr != nil || state.Group.Project.Directory != o.dir || card.Group != "" || card.Project != loose.Project {
		t.Fatalf("group=%+v task=%+v", state.Group.Project, card)
	}
}

func (o *ownership) teamMembers() []group.Member {
	return []group.Member{
		{ID: "human", Name: "Owner", Kind: group.MemberHuman, Role: group.RoleOwner},
		{ID: "lead", Name: "Lead", Kind: group.MemberAgent, AgentRole: group.AgentLeader, Agent: "leader-agent", Owner: "human"},
	}
}

func TestCreatingAGroupForATaskTakesItsWorkspaceAndThenTheTask(t *testing.T) {
	o := newOwnership(t)
	elsewhere := t.TempDir()
	loose, err := o.e.CreateTask(o.ctx, task.Card{Title: "Fresh", Description: "Start a team", Project: elsewhere, CreatedBy: humanActor})
	if err != nil {
		t.Fatal(err)
	}
	mismatch := group.Group{Kind: group.KindLocal, Name: "Wrong", Project: group.Project{Directory: o.dir}, Leader: "lead"}
	if _, err := o.e.CreateGroupForTask(o.ctx, mismatch, o.teamMembers(), loose.ID); errorCode(err) != "MRK-6015" {
		t.Fatalf("a workspace that is not the one of the task: %v", err)
	}
	if card, _ := o.e.Tasks.Get(o.ctx, loose.ID); card.Group != "" {
		t.Fatalf("a refused group took the task: %+v", card)
	}
	created, err := o.e.CreateGroupForTask(o.ctx, group.Group{Kind: group.KindLocal, Name: "Right", Leader: "lead"}, o.teamMembers(), loose.ID)
	if err != nil {
		t.Fatal(err)
	}
	if created.Project.Directory != elsewhere {
		t.Fatalf("the group works in %q", created.Project.Directory)
	}
	if card, err := o.e.Tasks.Get(o.ctx, loose.ID); err != nil || card.Group != created.ID {
		t.Fatalf("task=%+v err=%v", card, err)
	}
	if req := o.woken(); !strings.Contains(fmt.Sprint(req.Messages), string(loose.ID)) {
		t.Fatal("the first input of the new Leader lacks the task")
	}
}

func TestTasksTheLeaderCreatesBelongToItsGroupAndWorkersCannotCreateTasks(t *testing.T) {
	ctx, cancel := context.WithTimeout(t.Context(), 15*time.Second)
	defer cancel()
	dir := t.TempDir()
	var step atomic.Int32
	var parent event.ID
	var groupID atomic.Value
	call := func(input any) fake.Reply {
		body, _ := json.Marshal(input)
		return fake.Reply{Calls: []model.ToolCall{{ID: string(event.NewID()), Name: "create_task", Input: body}}}
	}
	workerTools := make(chan []string, 1)
	var e *engine.Engine
	leaderModel := groupScript{name: "leader-model", test: t, reply: func(req model.Request) fake.Reply {
		switch step.Add(1) {
		case 1:
			return call(map[string]any{"title": "Made by the Leader", "workspace": "none"})
		case 2:
			var card task.Card
			if listed, err := e.Tasks.List(ctx, groupID.Load().(event.ID)); err == nil && len(listed) == 1 {
				card = listed[0]
			}
			if card.ID == "" {
				t.Errorf("the Leader asked for a second task before the first one existed")
			}
			parent = card.ID
			return call(map[string]any{"title": "Part of it", "parent": card.ID, "workspace": "none"})
		}
		return fake.Reply{Text: "Done."}
	}}
	workerModel := groupScript{name: "worker-model", test: t, reply: func(req model.Request) fake.Reply {
		names := []string{}
		for _, spec := range req.Tools {
			names = append(names, spec.Name)
		}
		if slices.Contains(names, "submit_report") { // the assigned run, not an invitation to claim work
			select {
			case workerTools <- names:
			default:
			}
		}
		return fake.Reply{Text: "Waiting."}
	}}
	e, err := engine.New(engine.Deps{Workdir: dir, Providers: map[string]model.Provider{"leader-model": leaderModel, "worker-model": workerModel}})
	if err != nil {
		t.Fatal(err)
	}
	defer e.Close()
	lead, work := agent.DefaultLeader(), agent.DefaultWorker()
	lead.ID, lead.Model.Provider = "leader-agent", "leader-model"
	work.ID, work.Model.Provider = "worker-agent", "worker-model"
	g, err := createGroup(t, e, ctx, group.Group{Kind: group.KindLocal, Name: "Team", Project: group.Project{Directory: dir}, Leader: "leader"}, []group.Member{
		{ID: "human", Name: "Owner", Kind: group.MemberHuman, Role: group.RoleOwner},
		{ID: "leader", Name: "Leader", Kind: group.MemberAgent, AgentRole: group.AgentLeader, Agent: lead.ID, Owner: "human"},
		{ID: "worker", Name: "Worker", Kind: group.MemberAgent, AgentRole: group.AgentWorker, Agent: work.ID, Owner: "human"},
	}, []agent.Agent{lead, work})
	if err != nil {
		t.Fatal(err)
	}
	groupID.Store(g.ID)
	if _, err := e.SayGroup(ctx, g.ID, "", "human", group.Message{Text: "Make a plan", To: []event.ID{"leader"}}); err != nil {
		t.Fatal(err)
	}
	var cards []task.Card
	for ctx.Err() == nil {
		if cards, _ = e.Tasks.List(ctx, g.ID); len(cards) == 2 {
			break
		}
		time.Sleep(20 * time.Millisecond)
	}
	if len(cards) != 2 {
		t.Fatalf("cards=%d", len(cards))
	}
	for _, card := range cards {
		if card.Group != g.ID || card.Project != dir || card.Workspace != "none" {
			t.Errorf("card=%+v", card)
		}
		if card.ID != parent && card.Parent != parent {
			t.Errorf("the subtask has parent %q, want %q", card.Parent, parent)
		}
	}
	bound, err := e.FindEvents(ctx, store.Query{Scope: event.Scope{Group: g.ID}, Types: []event.Type{task.Bound}})
	if err != nil || len(bound) != 2 {
		t.Fatalf("bound events=%d err=%v", len(bound), err)
	}
	if _, err := e.CreateAssignedTask(ctx, task.Card{Group: g.ID, Title: "For the Worker", Workspace: "none", CreatedBy: humanActor}, "worker"); err != nil {
		t.Fatal(err)
	}
	select {
	case names := <-workerTools:
		if slices.Contains(names, "create_task") || !slices.Contains(names, "submit_report") {
			t.Fatalf("worker tools=%v", names)
		}
	case <-ctx.Done():
		t.Fatal("the Worker never received a request")
	}
}

func TestUpdatingTheProjectOfAGroupMovesItsOpenTasksOnlyWhenNothingIsRunning(t *testing.T) {
	o := newOwnership(t)
	open := o.working("Open work")
	elsewhere := t.TempDir()
	if _, err := o.e.UpdateGroup(o.ctx, o.group.ID, "human", group.Update{Project: &group.Project{Directory: o.dir + "/missing"}}); errorCode(err) != "MRK-6011" {
		t.Fatalf("a folder that does not exist: %v", err)
	}
	moved, err := o.e.UpdateGroup(o.ctx, o.group.ID, "human", group.Update{Project: &group.Project{Directory: elsewhere}})
	if err != nil || moved.Project.Directory != elsewhere {
		t.Fatalf("moved=%+v err=%v", moved.Project, err)
	}
	if card, err := o.e.Tasks.Get(o.ctx, open.ID); err != nil || card.Project != elsewhere {
		t.Fatalf("open task=%+v err=%v", card, err)
	}
	if _, err := o.e.CreateAssignedTask(o.ctx, task.Card{Group: o.group.ID, Title: "Busy", Workspace: "none", CreatedBy: humanActor}, "worker"); err != nil {
		t.Fatal(err)
	}
	o.waitFor("a running claim", func() bool {
		working, err := o.e.Tasks.Working(o.ctx, o.group.ID)
		return err == nil && working
	})
	if _, err := o.e.UpdateGroup(o.ctx, o.group.ID, "human", group.Update{Project: &group.Project{Directory: t.TempDir()}}); errorCode(err) != "MRK-6014" {
		t.Fatalf("moving while work runs: %v", err)
	}
	if state, err := o.e.Groups.Get(o.ctx, o.group.ID); err != nil || state.Group.Project.Directory != elsewhere {
		t.Fatalf("the refused move changed the group: %+v %v", state.Group.Project, err)
	}
}

func TestALeaderCannotAssignOrReadTheCardOfAnotherGroup(t *testing.T) {
	ctx, cancel := context.WithTimeout(t.Context(), 15*time.Second)
	defer cancel()
	dir := t.TempDir()
	var step atomic.Int32
	var foreign atomic.Value
	outcomes := make(chan bool, 4)
	call := func(name string, input any) fake.Reply {
		body, _ := json.Marshal(input)
		return fake.Reply{Calls: []model.ToolCall{{ID: string(event.NewID()), Name: name, Input: body}}}
	}
	leaderModel := groupScript{name: "leader-model", test: t, reply: func(req model.Request) fake.Reply {
		for _, part := range req.Messages[len(req.Messages)-1].Parts {
			if part.ToolResult != nil {
				outcomes <- part.ToolResult.IsError
			}
		}
		id, _ := foreign.Load().(event.ID)
		switch step.Add(1) {
		case 1:
			return call("assign_task", map[string]any{"task": id, "member": "worker"})
		case 2:
			return call("read_report", map[string]any{"task": id})
		}
		return fake.Reply{Text: "Done."}
	}}
	e, err := engine.New(engine.Deps{Workdir: dir, Providers: map[string]model.Provider{"leader-model": leaderModel, "worker-model": fake.New(t, fake.Reply{Hold: make(chan struct{})}), "quiet-model": groupScript{name: "quiet-model", test: t, reply: func(model.Request) fake.Reply { return fake.Reply{Text: "Noted."} }}}})
	if err != nil {
		t.Fatal(err)
	}
	defer e.Close()
	lead, work := agent.DefaultLeader(), agent.DefaultWorker()
	lead.ID, lead.Model.Provider = "leader-agent", "leader-model"
	work.ID, work.Model.Provider = "worker-agent", "worker-model"
	quiet := agent.DefaultLeader()
	quiet.ID, quiet.Model.Provider = "quiet-agent", "quiet-model"
	newGroup := func(name string, lead agent.Agent) group.Group {
		g, err := createGroup(t, e, ctx, group.Group{Kind: group.KindLocal, Name: name, Project: group.Project{Directory: dir}, Leader: "leader-" + event.ID(name)}, []group.Member{
			{ID: "human", Name: "Owner", Kind: group.MemberHuman, Role: group.RoleOwner},
			{ID: "leader-" + event.ID(name), Name: "Leader", Kind: group.MemberAgent, AgentRole: group.AgentLeader, Agent: lead.ID, Owner: "human"},
			{ID: "worker", Name: "Worker", Kind: group.MemberAgent, AgentRole: group.AgentWorker, Agent: work.ID, Owner: "human"},
		}, []agent.Agent{lead, work})
		if err != nil {
			t.Fatal(err)
		}
		return g
	}
	a, b := newGroup("A", lead), newGroup("B", quiet)
	other, err := e.CreateTask(ctx, task.Card{Group: b.ID, Title: "Belongs to B", Workspace: "none", CreatedBy: humanActor})
	if err != nil {
		t.Fatal(err)
	}
	foreign.Store(other.ID)
	if _, err := e.SayGroup(ctx, a.ID, "", "human", group.Message{Text: "Go", To: []event.ID{"leader-A"}}); err != nil {
		t.Fatal(err)
	}
	for _, tool := range []string{"assign_task", "read_report"} {
		select {
		case isError := <-outcomes:
			if !isError {
				t.Errorf("%s accepted the card of another group", tool)
			}
		case <-ctx.Done():
			t.Fatalf("no result of %s", tool)
		}
	}
	if card, err := e.Tasks.Get(ctx, other.ID); err != nil || len(card.Claims) != 0 {
		t.Fatalf("the card of B was assigned: %+v %v", card, err)
	}
}

func (o *ownership) cancelled(card task.Card) task.Card {
	o.t.Helper()
	if err := o.e.Tasks.SetPhase(o.ctx, card.ID, task.PhaseCancelled, humanActor); err != nil {
		o.t.Fatal(err)
	}
	card, err := o.e.Tasks.Get(o.ctx, card.ID)
	if err != nil {
		o.t.Fatal(err)
	}
	return card
}

// ids lists the ids of the cards in order, which is the order of creation only up to the millisecond.
func ids(cards []task.Card) []event.ID {
	result := []event.ID{}
	for _, card := range cards {
		result = append(result, card.ID)
	}
	slices.Sort(result)
	return result
}

func sorted(values ...event.ID) []event.ID {
	slices.Sort(values)
	return values
}

func TestGroupsAreListedForTheirMembersWithTheIdsOfTheirTasks(t *testing.T) {
	o := newOwnership(t)
	inGroup, err := o.e.CreateTask(o.ctx, task.Card{Group: o.group.ID, Title: "In the group", Workspace: "none", CreatedBy: humanActor})
	if err != nil {
		t.Fatal(err)
	}
	o.loose("Not in any group")
	listed, err := o.e.Board.Groups(o.ctx, "human")
	if err != nil || len(listed) != 1 || listed[0].ID != o.group.ID || !slices.Equal(listed[0].Tasks, []event.ID{inGroup.ID}) {
		t.Fatalf("listed=%+v err=%v", listed, err)
	}
	if strangers, err := o.e.Board.Groups(o.ctx, "stranger"); err != nil || len(strangers) != 0 {
		t.Fatalf("a stranger sees %+v err=%v", strangers, err)
	}
}

func TestTasksAreListedAcrossGroupsByProjectWithoutTheArchivedOnes(t *testing.T) {
	o := newOwnership(t)
	elsewhere := t.TempDir()
	inGroup, err := o.e.CreateTask(o.ctx, task.Card{Group: o.group.ID, Title: "In the group", Workspace: "none", CreatedBy: humanActor})
	if err != nil {
		t.Fatal(err)
	}
	alone := o.loose("Alone")
	away, err := o.e.CreateTask(o.ctx, task.Card{Title: "Away", Project: elsewhere, CreatedBy: humanActor})
	if err != nil {
		t.Fatal(err)
	}
	all, err := o.e.ListTasks(o.ctx, task.Filter{})
	if err != nil || !slices.Equal(ids(all), sorted(inGroup.ID, alone.ID, away.ID)) {
		t.Fatalf("all=%v err=%v", ids(all), err)
	}
	here, err := o.e.ListTasks(o.ctx, task.Filter{Project: o.dir})
	if err != nil || !slices.Equal(ids(here), sorted(inGroup.ID, alone.ID)) {
		t.Fatalf("here=%v err=%v", ids(here), err)
	}
	o.cancelled(away)
	if _, err := o.e.ArchiveTasks(o.ctx, []event.ID{away.ID}, true, humanActor); err != nil {
		t.Fatal(err)
	}
	visible, _ := o.e.ListTasks(o.ctx, task.Filter{})
	archived, _ := o.e.ListTasks(o.ctx, task.Filter{Archived: true})
	if slices.Contains(ids(visible), away.ID) || !slices.Equal(ids(archived), []event.ID{away.ID}) {
		t.Fatalf("visible=%v archived=%v", ids(visible), ids(archived))
	}
}

func TestFinishedTasksAreArchivedInBatchesAndCanBeRestored(t *testing.T) {
	o := newOwnership(t)
	grouped := o.cancelled(o.working("Group work"))
	alone := o.cancelled(o.loose("Alone"))
	unfinished := o.loose("Still going")
	if _, err := o.e.ArchiveTasks(o.ctx, []event.ID{grouped.ID, alone.ID, unfinished.ID}, true, humanActor); errorCode(err) != "MRK-6017" {
		t.Fatalf("a batch with an unfinished task: %v", err)
	}
	if listed, _ := o.e.ListTasks(o.ctx, task.Filter{Archived: true}); len(listed) != 0 {
		t.Fatalf("a refused batch archived %v", ids(listed))
	}
	if _, err := o.e.ArchiveTasks(o.ctx, []event.ID{grouped.ID, alone.ID}, true, humanActor); err != nil {
		t.Fatal(err)
	}
	facts, err := o.e.FindEvents(o.ctx, store.Query{Types: []event.Type{task.ArchivedEvent}})
	if err != nil || len(facts) != 2 {
		t.Fatalf("archive events=%d err=%v", len(facts), err)
	}
	want := map[event.ID]event.Stream{grouped.ID: event.Stream("group:" + o.group.ID), alone.ID: event.Stream("task:" + alone.ID)}
	for _, fact := range facts {
		if fact.Stream != want[fact.Scope.Task] || fact.Actor.ID != "human" {
			t.Errorf("archive event of %s: stream %q actor %+v", fact.Scope.Task, fact.Stream, fact.Actor)
		}
	}
	if _, err := o.e.ArchiveTasks(o.ctx, []event.ID{alone.ID}, false, humanActor); err != nil {
		t.Fatal(err)
	}
	visible, _ := o.e.ListTasks(o.ctx, task.Filter{})
	if !slices.Contains(ids(visible), alone.ID) || slices.Contains(ids(visible), grouped.ID) {
		t.Fatalf("visible after restoring one: %v", ids(visible))
	}
}

func TestFinishedTasksAreArchivedAutomaticallyAfterTheConfiguredDays(t *testing.T) {
	o := newOwnership(t)
	card := o.cancelled(o.loose("Old news"))
	live := o.loose("Live")
	archivedIDs := func() []event.ID {
		listed, err := o.e.ListTasks(o.ctx, task.Filter{Archived: true})
		if err != nil {
			t.Fatal(err)
		}
		return ids(listed)
	}
	o.advance(2*24*time.Hour + 23*time.Hour)
	if err := o.e.Board.ArchiveStale(o.ctx); err != nil || len(archivedIDs()) != 0 {
		t.Fatalf("before the third day: %v err=%v", archivedIDs(), err)
	}
	o.e.Board.Configure(7)
	o.advance(2 * time.Hour)
	if err := o.e.Board.ArchiveStale(o.ctx); err != nil || len(archivedIDs()) != 0 {
		t.Fatalf("with 7 days configured: %v err=%v", archivedIDs(), err)
	}
	o.e.Board.Configure(0)
	o.advance(30 * 24 * time.Hour)
	if err := o.e.Board.ArchiveStale(o.ctx); err != nil || len(archivedIDs()) != 0 {
		t.Fatalf("with auto-archive off: %v err=%v", archivedIDs(), err)
	}
	o.e.Board.Configure(3)
	if err := o.e.Board.ArchiveStale(o.ctx); err != nil || !slices.Equal(archivedIDs(), []event.ID{card.ID}) {
		t.Fatalf("after 3 days: %v err=%v (the live task %s must stay)", archivedIDs(), err, live.ID)
	}
	facts, _ := o.e.FindEvents(o.ctx, store.Query{Types: []event.Type{task.ArchivedEvent}})
	if len(facts) != 1 || facts[0].Actor.Kind != event.ActorSystem {
		t.Fatalf("the actor of the archive: %+v", facts)
	}
}

func TestOwnershipAndRoutingSurviveARestart(t *testing.T) {
	ctx, cancel := context.WithTimeout(t.Context(), 15*time.Second)
	defer cancel()
	dir, disk := t.TempDir(), memory.New()
	seen := make(chan string, 8)
	provider := groupScript{name: "leader-model", test: t, reply: func(req model.Request) fake.Reply {
		seen <- fmt.Sprint(req.Messages)
		return fake.Reply{Text: "Noted."}
	}}
	start := func() *engine.Engine {
		e, err := engine.New(engine.Deps{Store: disk, Workdir: dir, Providers: map[string]model.Provider{"leader-model": provider}})
		if err != nil {
			t.Fatal(err)
		}
		return e
	}
	first := start()
	lead := agent.DefaultLeader()
	lead.ID, lead.Model.Provider = "leader-agent", "leader-model"
	g, err := createGroup(t, first, ctx, group.Group{Kind: group.KindLocal, Name: "Team", Project: group.Project{Directory: dir}, Leader: "leader"}, []group.Member{
		{ID: "human", Name: "Owner", Kind: group.MemberHuman, Role: group.RoleOwner},
		{ID: "leader", Name: "Leader", Kind: group.MemberAgent, AgentRole: group.AgentLeader, Agent: lead.ID, Owner: "human"},
	}, []agent.Agent{lead})
	if err != nil {
		t.Fatal(err)
	}
	loose, err := first.CreateTask(ctx, task.Card{Title: "Before the restart", Project: dir, CreatedBy: humanActor})
	if err != nil {
		t.Fatal(err)
	}
	bound, err := first.BindTask(ctx, g.ID, loose.ID, "human")
	if err != nil {
		t.Fatal(err)
	}
	<-seen
	first.Close()

	next := start()
	defer next.Close()
	if err := next.Recover(ctx); err != nil {
		t.Fatal(err)
	}
	card, err := next.Tasks.Get(ctx, loose.ID)
	if err != nil || card.Group != g.ID || card.Project != dir {
		t.Fatalf("after the restart: %+v err=%v", card, err)
	}
	if _, err := next.BindTask(ctx, g.ID, loose.ID, "human"); errorCode(err) != "MRK-6013" {
		t.Fatalf("binding again after the restart: %v", err)
	}
	select {
	case text := <-seen:
		t.Fatalf("the recovered Leader saw the bound task again although it had answered it: %.200s", text)
	case <-time.After(300 * time.Millisecond):
	}
	if err := next.Tasks.SetPhase(ctx, bound.ID, task.PhaseCancelled, humanActor); err != nil {
		t.Fatal(err)
	}
	facts, err := next.FindEvents(ctx, store.Query{Scope: event.Scope{Task: loose.ID}, Types: []event.Type{task.Closed}})
	if err != nil || len(facts) == 0 || facts[len(facts)-1].Stream != event.Stream("group:"+g.ID) {
		t.Fatalf("closing events after the restart: %v %v", facts, err)
	}
	second, err := next.CreateTask(ctx, task.Card{Group: g.ID, Title: "After the restart", Workspace: "none", CreatedBy: humanActor})
	if err != nil {
		t.Fatal(err)
	}
	select {
	case text := <-seen:
		if !strings.Contains(text, string(second.ID)) {
			t.Fatalf("the Leader was woken without the new task: %.200s", text)
		}
	case <-ctx.Done():
		t.Fatal("the recovered group thread was not woken")
	}
}

func TestTheLeaderAnswersEveryWakeUpWithoutAPerMinuteTurnLimit(t *testing.T) {
	o := newOwnership(t)
	turns, stop := o.e.Bus.Subscribe(event.Filter{Scope: event.Scope{Group: o.group.ID}, Types: []event.Type{loop.TurnFinished}})
	defer stop()
	const wakeUps = 9
	for i := range wakeUps {
		if _, err := o.e.SayGroup(o.ctx, o.group.ID, "", "human", group.Message{Text: fmt.Sprintf("Question %d", i), To: []event.ID{"leader"}}); err != nil {
			t.Fatal(err)
		}
		select {
		case <-turns:
		case <-time.After(5 * time.Second):
			t.Fatalf("the Leader did not answer wake-up %d: a turn limit holds it back", i+1)
		}
	}
}
