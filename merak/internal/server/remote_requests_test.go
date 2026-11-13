package server_test

import (
	"context"
	"encoding/json"
	"slices"
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
	"github.com/TongTong313/merakcode/merak/engine/store"
	"github.com/TongTong313/merakcode/merak/engine/store/memory"
	"github.com/TongTong313/merakcode/merak/engine/task"
	"github.com/TongTong313/merakcode/merak/engine/worker"
	"github.com/TongTong313/merakcode/merak/engine/worker/remote"
	"github.com/TongTong313/merakcode/merak/internal/server"
	"github.com/TongTong313/merakcode/merak/protocol"
)

// observedRemoteStore schedules the independent subscriber before the requesting runner.
type observedRemoteStore struct {
	store.Store
	source   *engine.Engine
	observed sync.Map
}

func (s *observedRemoteStore) signal(id event.ID) chan struct{} {
	value, _ := s.observed.LoadOrStore(id, make(chan struct{}))
	return value.(chan struct{})
}

func (s *observedRemoteStore) Get(ctx context.Context, id event.ID) (event.Event, error) {
	if fact, err := s.source.GetEvent(ctx, id); err == nil && fact.Type == group.MemberAsked {
		select {
		case <-s.signal(id):
		case <-ctx.Done():
			return event.Event{}, ctx.Err()
		}
	}
	return s.Store.Get(ctx, id)
}

func TestRemoteRequestsAlreadyImportedByAnotherSubscriberStillReceiveOneAnswerPerGeneration(t *testing.T) {
	ctx, cancel := context.WithTimeout(t.Context(), 8*time.Second)
	defer cancel()
	ask := fake.Reply{Calls: []model.ToolCall{{ID: "ask", Name: "ask_leader", Input: json.RawMessage(`{"text":"Choose the next step"}`)}}}
	release := make(chan struct{})
	releaseRework := make(chan struct{})
	reportReply := fake.Reply{Hold: release, Calls: []model.ToolCall{{ID: "report", Name: "submit_report", Input: json.RawMessage(`{"verdict":"done","summary":"Completed","artifacts":[],"checks":[]}`)}}}
	reworkReply := reportReply
	reworkReply.Hold = releaseRework
	b, err := engine.New(engine.Deps{Workdir: t.TempDir(), Providers: map[string]model.Provider{"fake": fake.New(t, ask, reportReply, ask, reworkReply)}})
	if err != nil {
		t.Fatal(err)
	}
	defer b.Close()
	p := agent.DefaultMerakCode()
	p.ID, p.Model.Provider = "source-profile", "fake"
	if _, err := b.SaveAgent(ctx, "owner", p); err != nil {
		t.Fatal(err)
	}
	if _, err := b.Groups.Create(ctx, group.Group{ID: "source", Kind: group.KindLocal, Name: "Source", Leader: "leader", Project: group.Project{Directory: t.TempDir()}}, []group.Member{{ID: "leader", Name: "Leader", Kind: group.MemberAgent, AgentRole: group.AgentLeader, Agent: "builtin-merakcode"}, {ID: "worker", Name: "Worker", Kind: group.MemberAgent, AgentRole: group.AgentWorker, Agent: p.ID}}); err != nil {
		t.Fatal(err)
	}
	instance, err := server.Start(b, t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer instance.Close()
	storage := &observedRemoteStore{Store: memory.New(), source: b}
	bus := event.NewBus(storage, time.Now, event.NewID)
	var imports sync.Mutex
	importFact := func(ctx context.Context, fact event.Event) error {
		imports.Lock()
		defer imports.Unlock()
		if _, err := storage.Store.Get(ctx, fact.ID); err == nil {
			return nil
		}
		return bus.Import(ctx, fact)
	}
	stream := event.Stream("device:remote:connection:group:host")
	events, stop := b.Bus.Subscribe(event.Filter{Streams: []event.Stream{stream}})
	defer stop()
	answered := make(chan event.ID, 1)
	go func() {
		for {
			select {
			case fact, ok := <-events:
				if !ok {
					return
				}
				if err := importFact(ctx, fact); err != nil {
					return
				}
				if fact.Type == group.MemberAsked {
					close(storage.signal(fact.ID))
				}
				if fact.Type == group.MemberAnswered {
					select {
					case answered <- fact.Cause:
					default:
					}
				}
			case <-ctx.Done():
				return
			}
		}
	}()
	state := group.State{Group: group.Group{ID: "host", Kind: group.KindLocal, Name: "Host", Leader: "host-leader"}, Members: []group.Member{{ID: "alias", Name: "Alias", Kind: group.MemberAgent, AgentRole: group.AgentWorker}}}
	body, _ := json.Marshal(state)
	if _, err := bus.Publish(ctx, event.Event{Stream: "group:host", Scope: event.Scope{Group: "host"}, Type: group.Created, Payload: body}); err != nil {
		t.Fatal(err)
	}
	claim := task.Claim{ID: "claim", Task: "task", Session: "session", Member: "alias", Status: task.ClaimActive}
	card := task.Card{ID: claim.Task, Group: "host", Title: "Remote task", Workspace: "none", Status: task.Running, Claims: []task.Claim{claim}}
	var answers atomic.Int32
	var firstCause event.ID
	runner := remote.Runner{Source: agent.RemoteSource{Connection: "connection", Group: "source", Member: "worker"}, Bus: bus, Store: storage,
		Credentials: func(context.Context) (protocol.RemoteConnectParams, error) {
			return protocol.RemoteConnectParams{Endpoint: instance.Info.Endpoint, Token: instance.Info.Token}, nil
		},
		Import: func(ctx context.Context, fact event.Event) error {
			if fact.Type == group.MemberAsked {
				select {
				case <-storage.signal(fact.ID):
				case <-ctx.Done():
					return ctx.Err()
				}
			}
			return importFact(ctx, fact)
		},
		Reply: func(_ context.Context, fact event.Event) (protocol.RemoteControlParams, error) {
			answers.Add(1)
			return protocol.RemoteControlParams{QuestionReply: &protocol.DeviceAnswer{QuestionReplyParams: protocol.QuestionReplyParams{Request: fact.ID, Text: "Continue"}}}, nil
		},
	}
	for attempt := range 3 {
		if attempt != 1 {
			body, _ := json.Marshal(card)
			started, err := bus.Publish(ctx, event.Event{Stream: "group:host", Scope: event.Scope{Group: "host", Task: card.ID}, Type: task.Started, Payload: body})
			if err != nil {
				t.Fatal(err)
			}
			if firstCause == "" {
				firstCause = started.ID
			}
		}
		run, err := runner.Start(ctx, worker.Assignment{Claim: claim, Session: claim.Session, Scope: event.Scope{Group: "host", Task: card.ID}, Packet: "Ask and report."})
		if err != nil {
			t.Fatal(err)
		}
		if attempt == 0 {
			var request event.ID
			select {
			case request = <-answered:
			case <-ctx.Done():
				t.Fatal(ctx.Err())
			}
			retry, err := protocol.Connect(ctx, instance.Info.Endpoint, instance.Info.Token, protocol.HelloParams{Protocol: protocol.Version})
			if err != nil {
				t.Fatal(err)
			}
			defer retry.Close()
			var active protocol.RemoteStartResult
			if err := retry.Call(ctx, "remote.start", protocol.RemoteStartParams{Host: "connection", Assignment: protocol.DeviceAssignment{Cause: firstCause, SourceGroup: "source", Member: "worker", Claim: claim, Session: claim.Session, Scope: event.Scope{Group: "host", Task: card.ID}}}, &active); err != nil || active.Completed || !slices.Contains(active.Answered, request) {
				t.Fatalf("active retry forgot the resolved question: %+v %v", active, err)
			}
			close(release)
		}
		if attempt == 2 {
			select {
			case <-answered:
			case <-ctx.Done():
				t.Fatal(ctx.Err())
			}
			retry, err := protocol.Connect(ctx, instance.Info.Endpoint, instance.Info.Token, protocol.HelloParams{Protocol: protocol.Version})
			if err != nil {
				t.Fatal(err)
			}
			defer retry.Close()
			bounded, stop := context.WithTimeout(ctx, 500*time.Millisecond)
			var completed protocol.RemoteStartResult
			err = retry.Call(bounded, "remote.start", protocol.RemoteStartParams{Host: "connection", Assignment: protocol.DeviceAssignment{Cause: firstCause, SourceGroup: "source", Member: "worker", Claim: claim, Session: claim.Session, Scope: event.Scope{Group: "host", Task: card.ID}}}, &completed)
			stop()
			if err != nil || !completed.Completed {
				t.Fatalf("completed retry waited for active rework: %+v %v", completed, err)
			}
			close(releaseRework)
		}
		result, err := run.Wait(ctx)
		if err != nil || result.Verdict != task.VerdictDone {
			t.Fatalf("attempt %d: report=%+v %v", attempt, result, err)
		}
		want := int32(1)
		if attempt == 2 {
			want = 2
		}
		if answers.Load() != want {
			t.Fatalf("attempt %d: answers=%d want=%d", attempt, answers.Load(), want)
		}
	}
	client, err := protocol.Connect(ctx, instance.Info.Endpoint, instance.Info.Token, protocol.HelloParams{Protocol: protocol.Version})
	if err != nil {
		t.Fatal(err)
	}
	defer client.Close()
	var repeated protocol.RemoteStartResult
	if err := client.Call(ctx, "remote.start", protocol.RemoteStartParams{Host: "connection", Assignment: protocol.DeviceAssignment{Cause: firstCause, SourceGroup: "source", Member: "worker", Claim: claim, Session: claim.Session, Scope: event.Scope{Group: "host", Task: card.ID}}}, &repeated); err != nil || !repeated.Completed {
		t.Fatalf("old generation was executed again: %+v %v", repeated, err)
	}
}
