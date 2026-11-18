package sandbox_test

import (
	"context"
	"encoding/json"
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
	"github.com/TongTong313/merakcode/merak/engine/agent/session"
	"github.com/TongTong313/merakcode/merak/engine/collab/group"
	"github.com/TongTong313/merakcode/merak/engine/collab/task"
	"github.com/TongTong313/merakcode/merak/engine/infra/event"
	"github.com/TongTong313/merakcode/merak/engine/infra/store"
	storememory "github.com/TongTong313/merakcode/merak/storage/memory"
	"github.com/TongTong313/merakcode/merak/testkit/enginetest"
)

// The real store pauses around the packet's discussion snapshot.
type packetGate struct {
	store.Store
	used            atomic.Bool
	before          bool
	loaded, release chan struct{}
}

func (s *packetGate) Find(ctx context.Context, query store.Query) ([]event.Event, error) {
	pause := len(query.Types) == 2 && slices.Contains(query.Types, group.HumanSaid) && slices.Contains(query.Types, session.MessageCompleted) && s.used.CompareAndSwap(false, true)
	wait := func() error {
		close(s.loaded)
		select {
		case <-s.release:
			return nil
		case <-ctx.Done():
			return ctx.Err()
		}
	}
	if pause && s.before {
		if err := wait(); err != nil {
			return nil, err
		}
	}
	facts, err := s.Store.Find(ctx, query)
	if pause && !s.before {
		if err := wait(); err != nil {
			return nil, err
		}
	}
	return facts, err
}

func TestWorkerReceivesInputWhileItsMaterialPacketIsPreparing(t *testing.T) {
	for _, before := range []bool{false, true} {
		name := "after snapshot"
		if before {
			name = "before snapshot without duplicate delivery"
		}
		t.Run(name, func(t *testing.T) { testClaimInputDuringPreparation(t, before) })
	}
}

func testClaimInputDuringPreparation(t *testing.T, before bool) {
	ctx, cancel := context.WithTimeout(t.Context(), 10*time.Second)
	defer cancel()
	dir := t.TempDir()
	storage := &packetGate{Store: storememory.New(), before: before, loaded: make(chan struct{}), release: make(chan struct{})}
	var released sync.Once
	release := func() { released.Do(func() { close(storage.release) }) }
	defer release()
	barrier := make(chan struct{}, 1)
	received := make(chan string, 8)
	hold := make(chan struct{})
	lead := enginetest.GroupScript{ProviderName: "leader", Test: t, Reply: func(req model.Request) fake.Reply {
		body, _ := json.Marshal(req.Messages)
		if strings.Contains(string(body), "Routing barrier") {
			select {
			case barrier <- struct{}{}:
			default:
			}
		}
		return fake.Reply{Text: "Recorded"}
	}}
	work := enginetest.GroupScript{ProviderName: "worker", Test: t, Reply: func(req model.Request) fake.Reply {
		body, _ := json.Marshal(req.Messages)
		received <- string(body)
		return fake.Reply{Text: "Complete", Hold: hold}
	}}
	deps := enginetest.Deps(t)
	deps.Store = storage
	deps.Workdir = dir
	deps.Providers = map[string]model.Provider{"leader": lead, "worker": work}
	e, err := engine.New(deps)
	if err != nil {
		t.Fatal(err)
	}
	defer e.Close()
	defer close(hold)
	lp, wp := definition.DefaultMerakCode(), definition.DefaultMerakCode()
	lp.ID, lp.Model.Provider, wp.ID, wp.Model.Provider = "lead", "leader", "work", "worker"
	g, err := enginetest.CreateGroup(t, e, ctx, group.Group{Kind: group.KindLocal, Name: "Preparing input", Leader: "leader", Project: group.Project{Directory: dir}}, []group.Member{
		{ID: "owner", Name: "Owner", Kind: group.MemberHuman, Role: group.RoleOwner},
		{ID: "leader", Name: "Leader", Kind: group.MemberAgent, AgentRole: group.AgentLeader, Agent: lp.ID},
		{ID: "worker", Name: "Worker", Kind: group.MemberAgent, AgentRole: group.AgentWorker, Agent: wp.ID},
	}, []definition.Agent{lp, wp})
	if err != nil {
		t.Fatal(err)
	}
	card, err := e.CreateAssignedTask(ctx, task.Card{Group: g.ID, Title: "Check materials", Workspace: "none", CreatedBy: event.Actor{Kind: event.ActorHuman, ID: "owner"}}, "worker")
	if err != nil {
		t.Fatal(err)
	}
	select {
	case <-storage.loaded:
	case <-ctx.Done():
		t.Fatal(ctx.Err())
	}
	if _, err := e.SayGroup(ctx, g.ID, card.ID, "owner", group.Message{To: []event.ID{"worker"}, Text: "Instruction after packet snapshot"}); err != nil {
		t.Fatal(err)
	}
	if _, err := e.SayGroup(ctx, g.ID, "", "owner", group.Message{To: []event.ID{"leader"}, Text: "Routing barrier"}); err != nil {
		t.Fatal(err)
	}
	select {
	case <-barrier:
	case <-ctx.Done():
		t.Fatal(ctx.Err())
	}
	release()
	for {
		select {
		case body := <-received:
			if strings.Contains(body, "Instruction after packet snapshot") {
				if count := strings.Count(body, "Instruction after packet snapshot"); count != 1 {
					t.Fatalf("instruction delivered %d times", count)
				}
				return
			}
		case <-ctx.Done():
			t.Fatal("worker lost input received during packet preparation")
		}
	}
}
