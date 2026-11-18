package enginetest

import (
	"context"
	"fmt"
	"slices"
	"sync/atomic"
	"testing"
	"time"

	"github.com/TongTong313/merakcode/merak/cloudlink"
	"github.com/TongTong313/merakcode/merak/engine"
	"github.com/TongTong313/merakcode/merak/engine/agent/definition"
	"github.com/TongTong313/merakcode/merak/engine/agent/loop"
	"github.com/TongTong313/merakcode/merak/engine/agent/model"
	"github.com/TongTong313/merakcode/merak/engine/agent/model/fake"
	"github.com/TongTong313/merakcode/merak/engine/collab/group"
	"github.com/TongTong313/merakcode/merak/engine/collab/task"
	"github.com/TongTong313/merakcode/merak/engine/collab/wire"
	"github.com/TongTong313/merakcode/merak/engine/infra/event"
	"github.com/TongTong313/merakcode/merak/engine/infra/store"
)

// ownership is an engine with one local group whose Leader records every request it receives.
type ownership struct {
	t         *testing.T
	Context   context.Context
	Engine    *engine.Engine
	Directory string
	Group     group.Group
	requests  chan model.Request
	skew      atomic.Int64
}

// Advance moves the clock of the engine forward.
func (o *ownership) Advance(by time.Duration) { o.skew.Add(int64(by)) }

var HumanActor = event.Actor{Kind: event.ActorHuman, ID: "human"}

func NewOwnership(t *testing.T) *ownership {
	t.Helper()
	ctx, cancel := context.WithTimeout(t.Context(), 15*time.Second)
	t.Cleanup(cancel)
	o := &ownership{t: t, Context: ctx, Directory: t.TempDir(), requests: make(chan model.Request, 32)}
	provider := GroupScript{ProviderName: "leader-model", Test: t, Reply: func(req model.Request) fake.Reply {
		o.requests <- req
		return fake.Reply{Text: "Noted."}
	}}
	deps := Deps(t)
	deps.NewLink = func() wire.Link { return cloudlink.NewWebSocket() }
	deps.Workdir = o.Directory
	deps.Now = func() time.Time { return time.Now().Add(time.Duration(o.skew.Load())) }
	deps.Providers = map[string]model.Provider{"leader-model": provider, "worker-model": fake.New(t, fake.Reply{Hold: make(chan struct{})})}
	e, err := engine.New(deps)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { e.Close() })
	o.Engine = e
	lead, work := definition.DefaultMerakCode(), definition.DefaultMerakCode()
	lead.ID, lead.Model.Provider = "leader-agent", "leader-model"
	work.ID, work.Model.Provider = "worker-agent", "worker-model"
	o.Group, err = CreateGroup(t, e, ctx, group.Group{Kind: group.KindLocal, Name: "Team", Project: group.Project{Directory: o.Directory}, Leader: "leader"}, []group.Member{
		{ID: "human", Name: "Owner", Kind: group.MemberHuman, Role: group.RoleOwner},
		{ID: "leader", Name: "Leader", Kind: group.MemberAgent, AgentRole: group.AgentLeader, Agent: lead.ID, Owner: "human"},
		{ID: "worker", Name: "Worker", Kind: group.MemberAgent, AgentRole: group.AgentWorker, Agent: work.ID, Owner: "human"},
	}, []definition.Agent{lead, work})
	if err != nil {
		t.Fatal(err)
	}
	return o
}

// Quiet fails the test when the Leader receives a request within the wait.
func (o *ownership) Quiet(wait time.Duration) {
	o.t.Helper()
	select {
	case req := <-o.requests:
		o.t.Fatalf("the Leader was woken: %.200s", fmt.Sprint(req.Messages))
	case <-time.After(wait):
	}
}

// Woken returns the request that the Leader receives next.
func (o *ownership) Woken() model.Request {
	o.t.Helper()
	select {
	case req := <-o.requests:
		return req
	case <-o.Context.Done():
		o.t.Fatal("the Leader was not woken")
	}
	return model.Request{}
}

func (o *ownership) Loose(title string) task.Card {
	o.t.Helper()
	card, err := o.Engine.CreateTask(o.Context, task.Card{Title: title, Description: "Describe " + title, Project: o.Directory, CreatedBy: HumanActor})
	if err != nil {
		o.t.Fatal(err)
	}
	return card
}

// WaitFor polls until the condition holds.
func (o *ownership) WaitFor(what string, condition func() bool) {
	o.t.Helper()
	for o.Context.Err() == nil {
		if condition() {
			return
		}
		time.Sleep(20 * time.Millisecond)
	}
	o.t.Fatalf("timed out waiting for %s", what)
}

// Working creates a task in the group and waits until its Leader has seen it, so that the Leader has a thread.
func (o *ownership) Working(title string) task.Card {
	o.t.Helper()
	card, err := o.Engine.CreateTask(o.Context, task.Card{Group: o.Group.ID, Title: title, Workspace: "none", CreatedBy: HumanActor})
	if err != nil {
		o.t.Fatal(err)
	}
	o.Woken()
	o.WaitFor("the first turn of the Leader", func() bool {
		facts, _ := o.Engine.FindEvents(o.Context, store.Query{Scope: event.Scope{Group: o.Group.ID}, Types: []event.Type{loop.TurnFinished}})
		return len(facts) > 0
	})
	return card
}

func (o *ownership) TeamMembers() []group.Member {
	return []group.Member{
		{ID: "human", Name: "Owner", Kind: group.MemberHuman, Role: group.RoleOwner},
		{ID: "lead", Name: "Lead", Kind: group.MemberAgent, AgentRole: group.AgentLeader, Agent: "leader-agent", Owner: "human"},
	}
}

func (o *ownership) Cancelled(card task.Card) task.Card {
	o.t.Helper()
	if err := o.Engine.UpdateTask(o.Context, card.ID, task.Update{Phase: task.PhaseCancelled}, HumanActor); err != nil {
		o.t.Fatal(err)
	}
	card, err := o.Engine.Task(o.Context, card.ID)
	if err != nil {
		o.t.Fatal(err)
	}
	return card
}

// IDs lists the ids of the cards in order, which is the order of creation only up to the millisecond.
func IDs(cards []task.Card) []event.ID {
	result := []event.ID{}
	for _, card := range cards {
		result = append(result, card.ID)
	}
	slices.Sort(result)
	return result
}
