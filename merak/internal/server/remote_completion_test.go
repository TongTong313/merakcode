package server_test

import (
	"context"
	"encoding/json"
	"testing"
	"time"

	"github.com/TongTong313/merakcode/merak/engine"
	"github.com/TongTong313/merakcode/merak/engine/agent"
	"github.com/TongTong313/merakcode/merak/engine/event"
	"github.com/TongTong313/merakcode/merak/engine/group"
	"github.com/TongTong313/merakcode/merak/engine/model"
	"github.com/TongTong313/merakcode/merak/engine/model/fake"
	"github.com/TongTong313/merakcode/merak/engine/store"
	"github.com/TongTong313/merakcode/merak/engine/store/memory"
	"github.com/TongTong313/merakcode/merak/engine/task"
	"github.com/TongTong313/merakcode/merak/engine/worker"
	"github.com/TongTong313/merakcode/merak/engine/worker/remote"
	"github.com/TongTong313/merakcode/merak/internal/server"
	"github.com/TongTong313/merakcode/merak/protocol"
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
	b, err := engine.New(engine.Deps{Workdir: t.TempDir(), Providers: map[string]model.Provider{"fake": fake.New(t,
		fake.Reply{Calls: []model.ToolCall{{ID: "progress", Name: "report_progress", Input: json.RawMessage(`{"summary":"Finished the check"}`)}}},
		fake.Reply{Calls: []model.ToolCall{{ID: "report", Name: "submit_report", Input: json.RawMessage(`{"verdict":"done","summary":"Completed","artifacts":[],"checks":[]}`)}}},
	)}})
	if err != nil {
		t.Fatal(err)
	}
	defer b.Close()
	p := agent.DefaultWorker()
	p.ID, p.Model.Provider = "source-profile", "fake"
	if _, err := b.SaveAgent(ctx, "owner", p); err != nil {
		t.Fatal(err)
	}
	if _, err := b.Groups.Create(ctx, group.Group{ID: "source", Kind: group.KindLocal, Name: "Source", Leader: "leader", Project: group.Project{Directory: t.TempDir()}}, []group.Member{{ID: "leader", Name: "Leader", Kind: group.MemberAgent, AgentRole: group.AgentLeader, Agent: "builtin-leader"}, {ID: "worker", Name: "Worker", Kind: group.MemberAgent, AgentRole: group.AgentWorker, Agent: p.ID}}); err != nil {
		t.Fatal(err)
	}
	instance, err := server.Start(b, t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer instance.Close()
	facts, stop := b.Bus.Subscribe(event.Filter{Types: []event.Type{engine.DeviceReported}})
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
	runner := remote.Runner{Source: agent.RemoteSource{Connection: "connection", Group: "source", Member: "worker"}, Bus: bus, Store: storage,
		Credentials: func(context.Context) (protocol.RemoteConnectParams, error) {
			return protocol.RemoteConnectParams{Endpoint: instance.Info.Endpoint, Token: instance.Info.Token}, nil
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
