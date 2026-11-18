package cloudlink_test

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
	"github.com/TongTong313/merakcode/merak/engine/agent/definition"
	"github.com/TongTong313/merakcode/merak/engine/agent/loop"
	"github.com/TongTong313/merakcode/merak/engine/agent/model"
	"github.com/TongTong313/merakcode/merak/engine/agent/model/fake"
	"github.com/TongTong313/merakcode/merak/engine/collab/group"
	"github.com/TongTong313/merakcode/merak/engine/collab/leader"
	"github.com/TongTong313/merakcode/merak/engine/collab/task"
	"github.com/TongTong313/merakcode/merak/engine/infra/errorcode"
	"github.com/TongTong313/merakcode/merak/engine/infra/event"
	"github.com/TongTong313/merakcode/merak/engine/infra/store"
	"github.com/TongTong313/merakcode/merak/protocol"
	"github.com/TongTong313/merakcode/merak/storage/memory"
	"github.com/TongTong313/merakcode/merak/testkit/enginetest"
	"github.com/TongTong313/merakcode/merak/testkit/testcloud"
)

func TestATaskWithoutAGroupLivesInItsOwnStreamAndWakesNoLeader(t *testing.T) {
	o := enginetest.NewOwnership(t)
	card, err := o.Engine.CreateTask(o.Context, task.Card{Title: "Solo", Project: o.Directory, CreatedBy: enginetest.HumanActor})
	if err != nil {
		t.Fatal(err)
	}
	if card.Group != "" || card.Project != o.Directory {
		t.Fatalf("card=%+v", card)
	}
	facts, err := o.Engine.FindEvents(o.Context, store.Query{Scope: event.Scope{Task: card.ID}})
	if err != nil || len(facts) == 0 {
		t.Fatalf("facts=%d err=%v", len(facts), err)
	}
	for _, fact := range facts {
		if fact.Stream != event.Stream("task:"+card.ID) || fact.Scope.Group != "" {
			t.Fatalf("%s is in stream %q with scope %+v", fact.Type, fact.Stream, fact.Scope)
		}
	}
	o.Quiet(300 * time.Millisecond)
	for _, missing := range []task.Card{{Title: "No project", CreatedBy: enginetest.HumanActor}, {Title: "Gone", Project: o.Directory + "/missing", CreatedBy: enginetest.HumanActor}} {
		if _, err := o.Engine.CreateTask(o.Context, missing); err == nil {
			t.Errorf("a task with project %q was created", missing.Project)
		}
	}
}

func errorCode(err error) string {
	var failure *errorcode.Error
	if errors.As(err, &failure) {
		return failure.Code
	}
	return ""
}

func TestBindingATaskToAGroupWithTheSameWorkspaceWakesItsLeaderWithTheCard(t *testing.T) {
	o := enginetest.NewOwnership(t)
	card := o.Loose("Solo")
	bound, err := o.Engine.BindTask(o.Context, o.Group.ID, card.ID, "human")
	if err != nil {
		t.Fatal(err)
	}
	if bound.Group != o.Group.ID || bound.Project != o.Directory {
		t.Fatalf("bound=%+v", bound)
	}
	if req := o.Woken(); !strings.Contains(fmt.Sprint(req.Messages), string(card.ID)) {
		t.Fatalf("the first input of the Leader lacks the card: %.300s", fmt.Sprint(req.Messages))
	}
	facts, err := o.Engine.FindEvents(o.Context, store.Query{Scope: event.Scope{Group: o.Group.ID}, Types: []event.Type{task.Bound}})
	if err != nil || len(facts) != 1 || facts[0].Stream != event.Stream("group:"+o.Group.ID) {
		t.Fatalf("bound facts=%v err=%v", facts, err)
	}
	if err := o.Engine.UpdateTask(o.Context, card.ID, task.Update{Phase: task.PhaseCancelled}, enginetest.HumanActor); err != nil {
		t.Fatal(err)
	}
	later, err := o.Engine.FindEvents(o.Context, store.Query{Scope: event.Scope{Task: card.ID}, Types: []event.Type{task.Closed}})
	if err != nil || len(later) == 0 || later[len(later)-1].Stream != event.Stream("group:"+o.Group.ID) {
		t.Fatalf("after binding the events of the task are not in the stream of the group: %v %v", later, err)
	}
}

func TestATaskThatHasAGroupCannotBeBoundAgain(t *testing.T) {
	o := enginetest.NewOwnership(t)
	card := o.Loose("Solo")
	if _, err := o.Engine.BindTask(o.Context, o.Group.ID, card.ID, "human"); err != nil {
		t.Fatal(err)
	}
	if _, err := o.Engine.BindTask(o.Context, o.Group.ID, card.ID, "human"); errorCode(err) != "MRK-6013" {
		t.Fatalf("binding twice: %v", err)
	}
}

func TestCloudGroupsTakeNoTaskYet(t *testing.T) {
	o := enginetest.NewOwnership(t)
	peer := testcloud.New(t)
	peer.Handle = func(req protocol.Message) (any, error) {
		return group.Group{ID: "cloud-group", Kind: group.KindCloud}, nil
	}
	if err := o.Engine.ConnectCloud(o.Context, peer.Credentials()); err != nil {
		t.Fatal(err)
	}
	created, _ := json.Marshal(protocol.GroupCreateParams{Group: group.Group{Kind: group.KindCloud}, Members: []group.Member{{ID: "lead", Name: "Lead", Kind: group.MemberAgent, AgentRole: group.AgentLeader, Agent: "agent-1"}}})
	if _, handled, err := o.Engine.ForwardCloud(o.Context, "group.create", created); err != nil || !handled {
		t.Fatalf("create handled=%t err=%v", handled, err)
	}
	loose := o.Loose("Other")
	for method, params := range map[string]string{
		"group.bind":   fmt.Sprintf(`{"group":"cloud-group","task":%q}`, loose.ID),
		"group.create": fmt.Sprintf(`{"kind":"cloud","name":"Cloud","task":%q}`, loose.ID),
	} {
		if _, handled, err := o.Engine.ForwardCloud(o.Context, method, json.RawMessage(params)); !handled || errorCode(err) != "MRK-6016" {
			t.Errorf("%s: handled=%t err=%v", method, handled, err)
		}
	}
}

func TestBindingATaskWithAnotherWorkspaceMovesTheIdleGroupAndItsOpenTasks(t *testing.T) {
	o := enginetest.NewOwnership(t)
	open := o.Working("Open work")
	finished := o.Working("Finished work")
	if err := o.Engine.UpdateTask(o.Context, finished.ID, task.Update{Phase: task.PhaseCancelled}, enginetest.HumanActor); err != nil {
		t.Fatal(err)
	}
	other := t.TempDir()
	loose, err := o.Engine.CreateTask(o.Context, task.Card{Title: "Elsewhere", Project: other, CreatedBy: enginetest.HumanActor})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := o.Engine.BindTask(o.Context, o.Group.ID, loose.ID, "human"); err != nil {
		t.Fatal(err)
	}
	state, err := o.Engine.Group(o.Context, o.Group.ID)
	if err != nil || state.Group.Project.Directory != other {
		t.Fatalf("group project=%q err=%v", state.Group.Project.Directory, err)
	}
	for id, want := range map[event.ID]string{open.ID: other, loose.ID: other, finished.ID: o.Directory} {
		card, err := o.Engine.Task(o.Context, id)
		if err != nil || card.Project != want {
			t.Errorf("task %s project=%q want %q err=%v", id, card.Project, want, err)
		}
	}
	o.WaitFor("the handover of the Leader to a new session", func() bool {
		facts, _ := o.Engine.FindEvents(o.Context, store.Query{Scope: event.Scope{Group: o.Group.ID}, Types: []event.Type{leader.ThreadHandedOver}})
		if len(facts) == 0 {
			return false
		}
		handover, err := event.Decode[leader.Handover](facts[len(facts)-1])
		return err == nil && handover.Leader == "leader" && handover.Session != handover.Previous
	})
}

func TestAGroupWithRunningWorkRefusesAnotherWorkspaceAndStaysAsItWas(t *testing.T) {
	o := enginetest.NewOwnership(t)
	running, err := o.Engine.CreateAssignedTask(o.Context, task.Card{Group: o.Group.ID, Title: "Busy", Workspace: "none", CreatedBy: enginetest.HumanActor}, "worker")
	if err != nil {
		t.Fatal(err)
	}
	o.WaitFor("the claim to start", func() bool {
		card, err := o.Engine.Task(o.Context, running.ID)
		return err == nil && len(card.Claims) > 0 && card.Claims[0].Status == task.ClaimActive
	})
	loose, err := o.Engine.CreateTask(o.Context, task.Card{Title: "Elsewhere", Project: t.TempDir(), CreatedBy: enginetest.HumanActor})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := o.Engine.BindTask(o.Context, o.Group.ID, loose.ID, "human"); errorCode(err) != "MRK-6014" {
		t.Fatalf("binding while work runs: %v", err)
	}
	state, err := o.Engine.Group(o.Context, o.Group.ID)
	card, getErr := o.Engine.Task(o.Context, loose.ID)
	if err != nil || getErr != nil || state.Group.Project.Directory != o.Directory || card.Group != "" || card.Project != loose.Project {
		t.Fatalf("group=%+v task=%+v", state.Group.Project, card)
	}
}

func TestCreatingAGroupForATaskTakesItsWorkspaceAndThenTheTask(t *testing.T) {
	o := enginetest.NewOwnership(t)
	elsewhere := t.TempDir()
	loose, err := o.Engine.CreateTask(o.Context, task.Card{Title: "Fresh", Description: "Start a team", Project: elsewhere, CreatedBy: enginetest.HumanActor})
	if err != nil {
		t.Fatal(err)
	}
	mismatch := group.Group{Kind: group.KindLocal, Name: "Wrong", Project: group.Project{Directory: o.Directory}, Leader: "lead"}
	if _, err := o.Engine.CreateGroupForTask(o.Context, mismatch, o.TeamMembers(), loose.ID); errorCode(err) != "MRK-6015" {
		t.Fatalf("a workspace that is not the one of the task: %v", err)
	}
	if card, _ := o.Engine.Task(o.Context, loose.ID); card.Group != "" {
		t.Fatalf("a refused group took the task: %+v", card)
	}
	created, err := o.Engine.CreateGroupForTask(o.Context, group.Group{Kind: group.KindLocal, Name: "Right", Leader: "lead"}, o.TeamMembers(), loose.ID)
	if err != nil {
		t.Fatal(err)
	}
	if created.Project.Directory != elsewhere {
		t.Fatalf("the group works in %q", created.Project.Directory)
	}
	if card, err := o.Engine.Task(o.Context, loose.ID); err != nil || card.Group != created.ID {
		t.Fatalf("task=%+v err=%v", card, err)
	}
	if req := o.Woken(); !strings.Contains(fmt.Sprint(req.Messages), string(loose.ID)) {
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
	leaderModel := enginetest.GroupScript{ProviderName: "leader-model", Test: t, Reply: func(req model.Request) fake.Reply {
		switch step.Add(1) {
		case 1:
			return call(map[string]any{"title": "Made by the Leader", "workspace": "none"})
		case 2:
			var card task.Card
			if listed, err := e.GroupTasks(ctx, groupID.Load().(event.ID)); err == nil && len(listed) == 1 {
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
	workerModel := enginetest.GroupScript{ProviderName: "worker-model", Test: t, Reply: func(req model.Request) fake.Reply {
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
	deps2 := enginetest.Deps(t)
	deps2.Workdir = dir
	deps2.Providers = map[string]model.Provider{"leader-model": leaderModel, "worker-model": workerModel}
	e, err := engine.New(deps2)
	if err != nil {
		t.Fatal(err)
	}
	defer e.Close()
	lead, work := definition.DefaultMerakCode(), definition.DefaultMerakCode()
	lead.ID, lead.Model.Provider = "leader-agent", "leader-model"
	work.ID, work.Model.Provider = "worker-agent", "worker-model"
	g, err := enginetest.CreateGroup(t, e, ctx, group.Group{Kind: group.KindLocal, Name: "Team", Project: group.Project{Directory: dir}, Leader: "leader"}, []group.Member{
		{ID: "human", Name: "Owner", Kind: group.MemberHuman, Role: group.RoleOwner},
		{ID: "leader", Name: "Leader", Kind: group.MemberAgent, AgentRole: group.AgentLeader, Agent: lead.ID, Owner: "human"},
		{ID: "worker", Name: "Worker", Kind: group.MemberAgent, AgentRole: group.AgentWorker, Agent: work.ID, Owner: "human"},
	}, []definition.Agent{lead, work})
	if err != nil {
		t.Fatal(err)
	}
	groupID.Store(g.ID)
	if _, err := e.SayGroup(ctx, g.ID, "", "human", group.Message{Text: "Make a plan", To: []event.ID{"leader"}}); err != nil {
		t.Fatal(err)
	}
	var cards []task.Card
	for ctx.Err() == nil {
		if cards, _ = e.GroupTasks(ctx, g.ID); len(cards) == 2 {
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
	if _, err := e.CreateAssignedTask(ctx, task.Card{Group: g.ID, Title: "For the Worker", Workspace: "none", CreatedBy: enginetest.HumanActor}, "worker"); err != nil {
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
	o := enginetest.NewOwnership(t)
	open := o.Working("Open work")
	elsewhere := t.TempDir()
	if _, err := o.Engine.UpdateGroup(o.Context, o.Group.ID, "human", group.Update{Project: &group.Project{Directory: o.Directory + "/missing"}}); errorCode(err) != "MRK-6011" {
		t.Fatalf("a folder that does not exist: %v", err)
	}
	moved, err := o.Engine.UpdateGroup(o.Context, o.Group.ID, "human", group.Update{Project: &group.Project{Directory: elsewhere}})
	if err != nil || moved.Project.Directory != elsewhere {
		t.Fatalf("moved=%+v err=%v", moved.Project, err)
	}
	if card, err := o.Engine.Task(o.Context, open.ID); err != nil || card.Project != elsewhere {
		t.Fatalf("open task=%+v err=%v", card, err)
	}
	if _, err := o.Engine.CreateAssignedTask(o.Context, task.Card{Group: o.Group.ID, Title: "Busy", Workspace: "none", CreatedBy: enginetest.HumanActor}, "worker"); err != nil {
		t.Fatal(err)
	}
	o.WaitFor("a running claim", func() bool {
		cards, err := o.Engine.GroupTasks(o.Context, o.Group.ID)
		working := slices.ContainsFunc(cards, func(card task.Card) bool {
			return slices.ContainsFunc(card.Claims, func(claim task.Claim) bool {
				return claim.Status == task.ClaimActive || claim.Status == task.ClaimQueued
			})
		})
		return err == nil && working
	})
	if _, err := o.Engine.UpdateGroup(o.Context, o.Group.ID, "human", group.Update{Project: &group.Project{Directory: t.TempDir()}}); errorCode(err) != "MRK-6014" {
		t.Fatalf("moving while work runs: %v", err)
	}
	if state, err := o.Engine.Group(o.Context, o.Group.ID); err != nil || state.Group.Project.Directory != elsewhere {
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
	leaderModel := enginetest.GroupScript{ProviderName: "leader-model", Test: t, Reply: func(req model.Request) fake.Reply {
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
	deps3 := enginetest.Deps(t)
	deps3.Workdir = dir
	deps3.Providers = map[string]model.Provider{"leader-model": leaderModel, "worker-model": fake.New(t, fake.Reply{Hold: make(chan struct{})}), "quiet-model": enginetest.GroupScript{ProviderName: "quiet-model", Test: t, Reply: func(model.Request) fake.Reply { return fake.Reply{Text: "Noted."} }}}
	e, err := engine.New(deps3)
	if err != nil {
		t.Fatal(err)
	}
	defer e.Close()
	lead, work := definition.DefaultMerakCode(), definition.DefaultMerakCode()
	lead.ID, lead.Model.Provider = "leader-agent", "leader-model"
	work.ID, work.Model.Provider = "worker-agent", "worker-model"
	quiet := definition.DefaultMerakCode()
	quiet.ID, quiet.Model.Provider = "quiet-agent", "quiet-model"
	newGroup := func(name string, lead definition.Agent) group.Group {
		g, err := enginetest.CreateGroup(t, e, ctx, group.Group{Kind: group.KindLocal, Name: name, Project: group.Project{Directory: dir}, Leader: "leader-" + event.ID(name)}, []group.Member{
			{ID: "human", Name: "Owner", Kind: group.MemberHuman, Role: group.RoleOwner},
			{ID: "leader-" + event.ID(name), Name: "Leader", Kind: group.MemberAgent, AgentRole: group.AgentLeader, Agent: lead.ID, Owner: "human"},
			{ID: "worker", Name: "Worker", Kind: group.MemberAgent, AgentRole: group.AgentWorker, Agent: work.ID, Owner: "human"},
		}, []definition.Agent{lead, work})
		if err != nil {
			t.Fatal(err)
		}
		return g
	}
	a, b := newGroup("A", lead), newGroup("B", quiet)
	other, err := e.CreateTask(ctx, task.Card{Group: b.ID, Title: "Belongs to B", Workspace: "none", CreatedBy: enginetest.HumanActor})
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
	if card, err := e.Task(ctx, other.ID); err != nil || len(card.Claims) != 0 {
		t.Fatalf("the card of B was assigned: %+v %v", card, err)
	}
}

func sorted(values ...event.ID) []event.ID {
	slices.Sort(values)
	return values
}

func TestGroupsAreListedForTheirMembersWithTheIdsOfTheirTasks(t *testing.T) {
	o := enginetest.NewOwnership(t)
	inGroup, err := o.Engine.CreateTask(o.Context, task.Card{Group: o.Group.ID, Title: "In the group", Workspace: "none", CreatedBy: enginetest.HumanActor})
	if err != nil {
		t.Fatal(err)
	}
	o.Loose("Not in any group")
	listed, err := o.Engine.BoardGroups(o.Context, "human")
	if err != nil || len(listed) != 1 || listed[0].ID != o.Group.ID || !slices.Equal(listed[0].Tasks, []event.ID{inGroup.ID}) {
		t.Fatalf("listed=%+v err=%v", listed, err)
	}
	if strangers, err := o.Engine.BoardGroups(o.Context, "stranger"); err != nil || len(strangers) != 0 {
		t.Fatalf("a stranger sees %+v err=%v", strangers, err)
	}
}

func TestTasksAreListedAcrossGroupsByProjectWithoutTheArchivedOnes(t *testing.T) {
	o := enginetest.NewOwnership(t)
	elsewhere := t.TempDir()
	inGroup, err := o.Engine.CreateTask(o.Context, task.Card{Group: o.Group.ID, Title: "In the group", Workspace: "none", CreatedBy: enginetest.HumanActor})
	if err != nil {
		t.Fatal(err)
	}
	alone := o.Loose("Alone")
	away, err := o.Engine.CreateTask(o.Context, task.Card{Title: "Away", Project: elsewhere, CreatedBy: enginetest.HumanActor})
	if err != nil {
		t.Fatal(err)
	}
	all, err := o.Engine.ListTasks(o.Context, task.Filter{})
	if err != nil || !slices.Equal(enginetest.IDs(all), sorted(inGroup.ID, alone.ID, away.ID)) {
		t.Fatalf("all=%v err=%v", enginetest.IDs(all), err)
	}
	here, err := o.Engine.ListTasks(o.Context, task.Filter{Project: o.Directory})
	if err != nil || !slices.Equal(enginetest.IDs(here), sorted(inGroup.ID, alone.ID)) {
		t.Fatalf("here=%v err=%v", enginetest.IDs(here), err)
	}
	o.Cancelled(away)
	if _, err := o.Engine.ArchiveTasks(o.Context, []event.ID{away.ID}, true, enginetest.HumanActor); err != nil {
		t.Fatal(err)
	}
	visible, _ := o.Engine.ListTasks(o.Context, task.Filter{})
	archived, _ := o.Engine.ListTasks(o.Context, task.Filter{Archived: true})
	if slices.Contains(enginetest.IDs(visible), away.ID) || !slices.Equal(enginetest.IDs(archived), []event.ID{away.ID}) {
		t.Fatalf("visible=%v archived=%v", enginetest.IDs(visible), enginetest.IDs(archived))
	}
}

func TestFinishedTasksAreArchivedInBatchesAndCanBeRestored(t *testing.T) {
	o := enginetest.NewOwnership(t)
	grouped := o.Cancelled(o.Working("Group work"))
	alone := o.Cancelled(o.Loose("Alone"))
	unfinished := o.Loose("Still going")
	if _, err := o.Engine.ArchiveTasks(o.Context, []event.ID{grouped.ID, alone.ID, unfinished.ID}, true, enginetest.HumanActor); errorCode(err) != "MRK-6017" {
		t.Fatalf("a batch with an unfinished task: %v", err)
	}
	if listed, _ := o.Engine.ListTasks(o.Context, task.Filter{Archived: true}); len(listed) != 0 {
		t.Fatalf("a refused batch archived %v", enginetest.IDs(listed))
	}
	if _, err := o.Engine.ArchiveTasks(o.Context, []event.ID{grouped.ID, alone.ID}, true, enginetest.HumanActor); err != nil {
		t.Fatal(err)
	}
	facts, err := o.Engine.FindEvents(o.Context, store.Query{Types: []event.Type{task.ArchivedEvent}})
	if err != nil || len(facts) != 2 {
		t.Fatalf("archive events=%d err=%v", len(facts), err)
	}
	want := map[event.ID]event.Stream{grouped.ID: event.Stream("group:" + o.Group.ID), alone.ID: event.Stream("task:" + alone.ID)}
	for _, fact := range facts {
		if fact.Stream != want[fact.Scope.Task] || fact.Actor.ID != "human" {
			t.Errorf("archive event of %s: stream %q actor %+v", fact.Scope.Task, fact.Stream, fact.Actor)
		}
	}
	if _, err := o.Engine.ArchiveTasks(o.Context, []event.ID{alone.ID}, false, enginetest.HumanActor); err != nil {
		t.Fatal(err)
	}
	visible, _ := o.Engine.ListTasks(o.Context, task.Filter{})
	if !slices.Contains(enginetest.IDs(visible), alone.ID) || slices.Contains(enginetest.IDs(visible), grouped.ID) {
		t.Fatalf("visible after restoring one: %v", enginetest.IDs(visible))
	}
}

func TestOwnershipAndRoutingSurviveARestart(t *testing.T) {
	ctx, cancel := context.WithTimeout(t.Context(), 15*time.Second)
	defer cancel()
	dir, disk := t.TempDir(), memory.New()
	seen := make(chan string, 8)
	provider := enginetest.GroupScript{ProviderName: "leader-model", Test: t, Reply: func(req model.Request) fake.Reply {
		seen <- fmt.Sprint(req.Messages)
		return fake.Reply{Text: "Noted."}
	}}
	start := func() *engine.Engine {
		deps4 := enginetest.Deps(t)
		deps4.Store = disk
		deps4.Workdir = dir
		deps4.Providers = map[string]model.Provider{"leader-model": provider}
		e, err := engine.New(deps4)
		if err != nil {
			t.Fatal(err)
		}
		return e
	}
	first := start()
	lead := definition.DefaultMerakCode()
	lead.ID, lead.Model.Provider = "leader-agent", "leader-model"
	g, err := enginetest.CreateGroup(t, first, ctx, group.Group{Kind: group.KindLocal, Name: "Team", Project: group.Project{Directory: dir}, Leader: "leader"}, []group.Member{
		{ID: "human", Name: "Owner", Kind: group.MemberHuman, Role: group.RoleOwner},
		{ID: "leader", Name: "Leader", Kind: group.MemberAgent, AgentRole: group.AgentLeader, Agent: lead.ID, Owner: "human"},
	}, []definition.Agent{lead})
	if err != nil {
		t.Fatal(err)
	}
	loose, err := first.CreateTask(ctx, task.Card{Title: "Before the restart", Project: dir, CreatedBy: enginetest.HumanActor})
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
	card, err := next.Task(ctx, loose.ID)
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
	if err := next.UpdateTask(ctx, bound.ID, task.Update{Phase: task.PhaseCancelled}, enginetest.HumanActor); err != nil {
		t.Fatal(err)
	}
	facts, err := next.FindEvents(ctx, store.Query{Scope: event.Scope{Task: loose.ID}, Types: []event.Type{task.Closed}})
	if err != nil || len(facts) == 0 || facts[len(facts)-1].Stream != event.Stream("group:"+g.ID) {
		t.Fatalf("closing events after the restart: %v %v", facts, err)
	}
	second, err := next.CreateTask(ctx, task.Card{Group: g.ID, Title: "After the restart", Workspace: "none", CreatedBy: enginetest.HumanActor})
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
	o := enginetest.NewOwnership(t)
	turns, stop := o.Engine.Subscribe(event.Filter{Scope: event.Scope{Group: o.Group.ID}, Types: []event.Type{loop.TurnFinished}})
	defer stop()
	const wakeUps = 9
	for i := range wakeUps {
		if _, err := o.Engine.SayGroup(o.Context, o.Group.ID, "", "human", group.Message{Text: fmt.Sprintf("Question %d", i), To: []event.ID{"leader"}}); err != nil {
			t.Fatal(err)
		}
		select {
		case <-turns:
		case <-time.After(5 * time.Second):
			t.Fatalf("the Leader did not answer wake-up %d: a turn limit holds it back", i+1)
		}
	}
}
