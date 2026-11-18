package server_test

import (
	"context"
	"encoding/json"
	"testing"
	"time"

	"github.com/TongTong313/merakcode/merak/cloudlink"
	"github.com/TongTong313/merakcode/merak/engine"
	"github.com/TongTong313/merakcode/merak/engine/agent/definition"
	"github.com/TongTong313/merakcode/merak/engine/agent/model"
	"github.com/TongTong313/merakcode/merak/engine/agent/model/fake"
	"github.com/TongTong313/merakcode/merak/engine/collab/group"
	"github.com/TongTong313/merakcode/merak/engine/collab/remote"
	"github.com/TongTong313/merakcode/merak/engine/collab/task"
	"github.com/TongTong313/merakcode/merak/engine/collab/wire"
	"github.com/TongTong313/merakcode/merak/engine/collab/worker"
	workerremote "github.com/TongTong313/merakcode/merak/engine/collab/worker/remote"
	"github.com/TongTong313/merakcode/merak/engine/infra/event"
	"github.com/TongTong313/merakcode/merak/engine/infra/store"
	"github.com/TongTong313/merakcode/merak/server"
	"github.com/TongTong313/merakcode/merak/storage/memory"
	"github.com/TongTong313/merakcode/merak/testkit/enginetest"
)

// completedRemoteStore delays the first local replay until the device has finished.
type completedRemoteStore struct {
	store.Store
	completed <-chan struct{}
}

func (s completedRemoteStore) Read(ctx context.Context, stream event.Stream, from uint64, limit int) ([]event.Event, error) {
	if stream == "session:fast-session" {
		select {
		case <-s.completed:
		case <-ctx.Done():
			return nil, ctx.Err()
		}
	}
	return s.Store.Read(ctx, stream, from, limit)
}

func TestFastRemoteCompletionImportsDeviceProgressBeforeReturningItsReport(t *testing.T) {
	ctx, cancel := context.WithTimeout(t.Context(), 5*time.Second)
	defer cancel()
	deps := enginetest.Deps(t)
	deps.Dial = cloudlink.Dial
	deps.Workdir = t.TempDir()
	deps.Providers = map[string]model.Provider{"fake": fake.New(t,
		fake.Reply{Calls: []model.ToolCall{{ID: "progress", Name: "report_progress", Input: json.RawMessage(`{"summary":"Finished the check"}`)}}},
		fake.Reply{Calls: []model.ToolCall{{ID: "report", Name: "submit_report", Input: json.RawMessage(`{"verdict":"done","summary":"Completed","artifacts":[],"checks":[]}`)}}},
	)}
	b, err := engine.New(deps)
	if err != nil {
		t.Fatal(err)
	}
	defer b.Close()
	p := definition.DefaultMerakCode()
	p.ID, p.Model.Provider = "source-profile", "fake"
	if _, err := b.SaveAgent(ctx, "owner", p); err != nil {
		t.Fatal(err)
	}
	if _, err := b.CreateGroup(ctx, group.Group{ID: "source", Kind: group.KindLocal, Name: "Source", Leader: "leader", Project: group.Project{Directory: t.TempDir()}}, []group.Member{{ID: "leader", Name: "Leader", Kind: group.MemberAgent, AgentRole: group.AgentLeader, Agent: "builtin-merakcode"}, {ID: "worker", Name: "Worker", Kind: group.MemberAgent, AgentRole: group.AgentWorker, Agent: p.ID}}); err != nil {
		t.Fatal(err)
	}
	instance, err := server.Start(b, t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer instance.Close()
	facts, stop := b.Subscribe(event.Filter{Types: []event.Type{remote.DeviceReported}})
	defer stop()
	completed := make(chan struct{})
	go func() {
		select {
		case <-facts:
			close(completed)
		case <-ctx.Done():
		}
	}()
	storage := completedRemoteStore{Store: memory.New(), completed: completed}
	bus := event.NewBus(storage, time.Now, event.NewID)
	state := group.State{Group: group.Group{ID: "host", Kind: group.KindLocal, Name: "Host", Leader: "host-leader"}, Members: []group.Member{{ID: "alias", Name: "Alias", Kind: group.MemberAgent, AgentRole: group.AgentWorker}}}
	body, _ := json.Marshal(state)
	if _, err := bus.Publish(ctx, event.Event{Stream: "group:host", Scope: event.Scope{Group: "host"}, Type: group.Created, Payload: body}); err != nil {
		t.Fatal(err)
	}
	claim := task.Claim{ID: "claim", Task: "task", Session: "fast-session", Member: "alias", Status: task.ClaimActive}
	card := task.Card{ID: claim.Task, Group: "host", Title: "Remote task", Workspace: "none", Status: task.Running, Claims: []task.Claim{claim}}
	body, _ = json.Marshal(card)
	if _, err := bus.Publish(ctx, event.Event{Stream: "group:host", Scope: event.Scope{Group: "host", Task: card.ID}, Type: task.Started, Payload: body}); err != nil {
		t.Fatal(err)
	}
	runner := workerremote.Runner{Dial: cloudlink.Dial, Source: definition.RemoteSource{Connection: "connection", Group: "source", Member: "worker"}, Bus: bus, Store: storage,
		Credentials: func(context.Context) (wire.RemoteConnectParams, error) {
			return wire.RemoteConnectParams{Endpoint: instance.Info.Endpoint, Token: instance.Info.Token}, nil
		},
		Import: func(ctx context.Context, fact event.Event) error {
			if _, err := storage.Get(ctx, fact.ID); err == nil {
				return nil
			}
			return bus.Import(ctx, fact)
		},
	}
	run, err := runner.Start(ctx, worker.Assignment{Claim: claim, Session: claim.Session, Scope: event.Scope{Group: "host", Task: card.ID}, Packet: "Report progress and finish."})
	if err != nil {
		t.Fatal(err)
	}
	if report, err := run.Wait(ctx); err != nil || report.Verdict != task.VerdictDone {
		t.Fatalf("report=%+v %v", report, err)
	}
	progress, err := storage.Find(ctx, store.Query{Scope: event.Scope{Group: "host"}, Types: []event.Type{task.Progressed}})
	if err != nil || len(progress) != 1 {
		t.Fatalf("device progress was lost: %d %v", len(progress), err)
	}
}
