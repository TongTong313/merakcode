package engine_test

import (
	"context"
	"encoding/json"
	"errors"
	"github.com/TongTong313/merakcode/merak/engine"
	"github.com/TongTong313/merakcode/merak/engine/agent"
	"github.com/TongTong313/merakcode/merak/engine/event"
	"github.com/TongTong313/merakcode/merak/engine/group"
	"github.com/TongTong313/merakcode/merak/engine/model"
	"github.com/TongTong313/merakcode/merak/engine/model/fake"
	"github.com/TongTong313/merakcode/merak/engine/permission"
	"github.com/TongTong313/merakcode/merak/engine/question"
	"github.com/TongTong313/merakcode/merak/engine/session"
	"github.com/TongTong313/merakcode/merak/engine/store"
	"github.com/TongTong313/merakcode/merak/engine/store/memory"
	"github.com/TongTong313/merakcode/merak/engine/task"
	"github.com/TongTong313/merakcode/merak/engine/tool"
	"github.com/TongTong313/merakcode/merak/internal/cloud"
	"github.com/TongTong313/merakcode/merak/internal/testcloud"
	"github.com/TongTong313/merakcode/merak/protocol"
	"os"
	"os/exec"
	"path/filepath"
	"sync/atomic"
	"testing"
	"time"
)

type cloudRouteStore struct {
	store.Store
	reads   atomic.Int32
	armed   atomic.Bool
	checked chan struct{}
	resume  chan struct{}
}

func (s *cloudRouteStore) Fetch(ctx context.Context, kind, key string) (store.Doc, error) {
	doc, err := s.Store.Fetch(ctx, kind, key)
	if s.armed.Load() && kind == "cloud-group" && s.reads.Add(1) == 2 {
		close(s.checked)
		select {
		case <-s.resume:
		case <-ctx.Done():
			return store.Doc{}, ctx.Err()
		}
	}
	return doc, err
}

func TestCloudAccountSwitchCannotForwardAnOldGroupRequestThroughTheNewLink(t *testing.T) {
	ctx, cancel := context.WithTimeout(t.Context(), 5*time.Second)
	defer cancel()
	first, second := testcloud.New(t), testcloud.New(t)
	first.Handle = func(protocol.Message) (any, error) { return group.Group{ID: "old-group", Kind: group.KindCloud}, nil }
	var received atomic.Int32
	second.Handle = func(protocol.Message) (any, error) { received.Add(1); return "leaked", nil }
	storage := &cloudRouteStore{Store: memory.New(), checked: make(chan struct{}), resume: make(chan struct{})}
	e, err := engine.New(engine.Deps{Workdir: t.TempDir(), Store: storage})
	if err != nil {
		t.Fatal(err)
	}
	defer e.Close()
	if err := e.ConnectCloud(ctx, first.Credentials()); err != nil {
		t.Fatal(err)
	}
	if _, _, err := e.ForwardCloud(ctx, "group.create", json.RawMessage(`{"kind":"cloud"}`)); err != nil {
		t.Fatal(err)
	}
	storage.armed.Store(true)
	done := make(chan error, 1)
	go func() {
		_, _, err := e.ForwardCloud(ctx, "group.say", json.RawMessage(`{"group":"old-group","text":"private"}`))
		done <- err
	}()
	select {
	case <-storage.checked:
	case <-ctx.Done():
		t.Fatal(ctx.Err())
	}
	if err := e.DisconnectCloud(ctx); err != nil {
		t.Fatal(err)
	}
	if err := e.ConnectCloud(ctx, second.Credentials()); err != nil {
		t.Fatal(err)
	}
	close(storage.resume)
	select {
	case err := <-done:
		if !errors.Is(err, cloud.ErrNoCloud) || received.Load() != 0 {
			t.Fatalf("switched request=%v new account requests=%d", err, received.Load())
		}
	case <-ctx.Done():
		t.Fatal(ctx.Err())
	}
}

func TestCloudGroupRequiresAnAccountWhileLocalGroupsRemainAvailable(t *testing.T) {
	e, err := engine.New(engine.Deps{Workdir: t.TempDir()})
	if err != nil {
		t.Fatal(err)
	}
	defer e.Close()
	_, err = createGroup(t, e, t.Context(), group.Group{Kind: "cloud", Name: "Cloud"}, nil, nil)
	if err == nil || err.Error() != "MRK-1006" {
		t.Fatalf("cloud error=%v", err)
	}
}

func TestGroupDiscoveryIncludesCloudHistoryAndHidesItAfterLogout(t *testing.T) {
	ctx, cancel := context.WithTimeout(t.Context(), 5*time.Second)
	defer cancel()
	body, _ := json.Marshal(group.State{Group: group.Group{ID: "discovered", Kind: group.KindCloud, Name: "Existing cloud group"}})
	fact := event.Event{ID: "discovered-creation", Stream: "group:discovered", Seq: 1, Time: time.Now(), Type: group.Created, Scope: event.Scope{Group: "discovered"}, Payload: body}
	peer := testcloud.New(t)
	peer.Handle = func(request protocol.Message) (any, error) {
		if request.Method != "events.find" {
			t.Errorf("unexpected method %s", request.Method)
		}
		return []event.Event{fact}, nil
	}
	e, err := engine.New(engine.Deps{Workdir: t.TempDir()})
	if err != nil {
		t.Fatal(err)
	}
	defer e.Close()
	if err := e.ConnectCloud(ctx, peer.Credentials()); err != nil {
		t.Fatal(err)
	}
	facts, err := e.FindEvents(ctx, store.Query{Types: []event.Type{group.Created}})
	if err != nil || len(facts) != 1 || facts[0].ID != fact.ID {
		t.Fatalf("cloud groups=%+v %v", facts, err)
	}
	if err := e.DisconnectCloud(ctx); err != nil {
		t.Fatal(err)
	}
	facts, err = e.FindEvents(ctx, store.Query{Types: []event.Type{group.Created}})
	if err != nil || len(facts) != 0 {
		t.Fatalf("signed-out groups=%+v %v", facts, err)
	}
}

func TestCloudReconnectsAfterTheInitialHostIsOffline(t *testing.T) {
	peer := testcloud.New(t)
	peer.Paused.Store(true)
	e, err := engine.New(engine.Deps{Workdir: t.TempDir(), Cloud: cloud.NewWebSocket()})
	if err != nil {
		t.Fatal(err)
	}
	defer e.Close()
	first, cancel := context.WithTimeout(t.Context(), 50*time.Millisecond)
	err = e.ConnectCloud(first, peer.Credentials())
	cancel()
	if err != nil {
		t.Fatalf("offline startup discarded the account: %v", err)
	}
	if status := e.CloudStatus(); status.Account != "fixture-account" || status.Online {
		t.Fatalf("offline=%+v", status)
	}
	peer.Paused.Store(false)
	select {
	case <-peer.Announced:
	case <-time.After(5 * time.Second):
		t.Fatal("link did not reconnect and announce")
	}
}

func TestCloudEventsFillSequenceGapsBeforeDeliveringLaterFacts(t *testing.T) {
	ctx, cancel := context.WithTimeout(t.Context(), 3*time.Second)
	defer cancel()
	body, _ := json.Marshal(group.State{Group: group.Group{ID: "history", Kind: group.KindCloud, Name: "History"}})
	facts := []event.Event{{ID: "history-1", Stream: "group:history", Seq: 1, Time: time.Now(), Type: group.Created, Scope: event.Scope{Group: "history"}, Payload: body}, {ID: "history-2", Stream: "group:history", Seq: 2, Time: time.Now(), Type: group.HumanSaid, Scope: event.Scope{Group: "history"}, Payload: json.RawMessage(`{"text":"missing"}`)}, {ID: "history-3", Stream: "group:history", Seq: 3, Time: time.Now(), Type: group.HumanSaid, Scope: event.Scope{Group: "history"}, Payload: json.RawMessage(`{"text":"later"}`)}}
	peer := testcloud.New(t)
	peer.Handle = func(request protocol.Message) (any, error) {
		var read protocol.EventsReadParams
		if request.Method != "events.read" || json.Unmarshal(request.Params, &read) != nil {
			t.Errorf("unexpected method %s", request.Method)
			return nil, nil
		}
		var result []event.Event
		for _, fact := range facts {
			if fact.Seq >= read.From && len(result) < read.Limit {
				result = append(result, fact)
			}
		}
		return result, nil
	}
	e, err := engine.New(engine.Deps{Workdir: t.TempDir(), Cloud: cloud.NewWebSocket()})
	if err != nil {
		t.Fatal(err)
	}
	defer e.Close()
	if err = e.ConnectCloud(ctx, peer.Credentials()); err != nil {
		t.Fatal(err)
	}
	events, stop := e.Bus.Subscribe(event.Filter{Scope: event.Scope{Group: "history"}})
	defer stop()
	if err = peer.Send(ctx, protocol.CloudInbound{Events: []event.Event{facts[2]}}); err != nil {
		t.Fatal(err)
	}
	for _, want := range facts {
		select {
		case got := <-events:
			if got.ID != want.ID || got.Seq != want.Seq {
				t.Fatalf("event=%+v", got)
			}
		case <-ctx.Done():
			t.Fatal(ctx.Err())
		}
	}
}

func TestCloudRecoveryReportsAnInterruptedClaimWithoutRestartingIt(t *testing.T) {
	ctx, cancel := context.WithTimeout(t.Context(), 3*time.Second)
	defer cancel()
	peer := testcloud.New(t)
	storage := memory.New()
	a := protocol.DeviceAssignment{Cause: "recovered-start", SourceGroup: "source", Member: "worker", Claim: task.Claim{ID: "recovered-claim", Task: "recovered-task", Member: "worker", Session: "recovered-session", Status: task.ClaimActive}, Session: "recovered-session", Scope: event.Scope{Group: "recovered-group", Task: "recovered-task", Session: "recovered-session"}, Packet: "Old assignment"}
	body, _ := json.Marshal(map[string]any{"assignment": a, "status": "active", "host": cloud.Identity(peer.Credentials())})
	if err := storage.Put(ctx, store.Doc{Kind: "device-run", Key: string(a.Claim.ID), Body: body}); err != nil {
		t.Fatal(err)
	}
	e, err := engine.New(engine.Deps{Store: storage, Workdir: t.TempDir(), Cloud: cloud.NewWebSocket()})
	if err != nil {
		t.Fatal(err)
	}
	defer e.Close()
	if err = e.ConnectCloud(ctx, peer.Credentials()); err != nil {
		t.Fatal(err)
	}
	for {
		select {
		case fact := <-peer.Published:
			if fact.Type != engine.DeviceInterrupted {
				continue
			}
			claim, err := event.Decode[task.Claim](fact)
			if err != nil || claim.ID != a.Claim.ID || claim.Status != task.ClaimInterrupted {
				t.Fatalf("recovered=%+v %v", claim, err)
			}
			return
		case <-ctx.Done():
			t.Fatal(ctx.Err())
		}
	}
}

func TestCloudAccountChangeDoesNotForwardAnotherAccountsGroup(t *testing.T) {
	ctx, cancel := context.WithTimeout(t.Context(), 5*time.Second)
	defer cancel()
	peer := testcloud.New(t)
	e, err := engine.New(engine.Deps{Workdir: t.TempDir()})
	if err != nil {
		t.Fatal(err)
	}
	defer e.Close()
	if err := e.ConnectCloud(ctx, peer.Credentials()); err != nil {
		t.Fatal(err)
	}
	events, stop := e.Bus.Subscribe(event.Filter{Types: []event.Type{group.Created}})
	defer stop()
	body, _ := json.Marshal(group.State{Group: group.Group{ID: "account-group", Kind: group.KindCloud}})
	if err := peer.Send(ctx, protocol.CloudInbound{Events: []event.Event{{ID: "account-created", Stream: "group:account-group", Seq: 1, Time: time.Now(), Type: group.Created, Scope: event.Scope{Group: "account-group"}, Payload: body}}}); err != nil {
		t.Fatal(err)
	}
	select {
	case <-events:
	case <-ctx.Done():
		t.Fatal(ctx.Err())
	}
	if err := e.DisconnectCloud(ctx); err != nil {
		t.Fatal(err)
	}
	creds := peer.Credentials()
	creds.Account = "another-account"
	if err := e.ConnectCloud(ctx, creds); err != nil {
		t.Fatal(err)
	}
	_, handled, err := e.ForwardCloud(ctx, "group.say", json.RawMessage(`{"group":"account-group","text":"Private"}`))
	if !handled || !errors.Is(err, cloud.ErrNoCloud) {
		t.Fatalf("cross-account forwarding: handled=%v error=%v", handled, err)
	}
}

func TestCloudNoticeReachesTheInboxWithoutBeingUploaded(t *testing.T) {
	ctx, cancel := context.WithTimeout(t.Context(), 3*time.Second)
	defer cancel()
	peer := testcloud.New(t)
	e, err := engine.New(engine.Deps{Workdir: t.TempDir()})
	if err != nil {
		t.Fatal(err)
	}
	defer e.Close()
	if err := e.ConnectCloud(ctx, peer.Credentials()); err != nil {
		t.Fatal(err)
	}
	changes, stop := e.Bus.Subscribe(event.Filter{Types: []event.Type{group.NoticeSent}})
	defer stop()
	body, _ := json.Marshal(group.State{Group: group.Group{ID: "notice-group", Kind: group.KindCloud}})
	if err := peer.Send(ctx, protocol.CloudInbound{Events: []event.Event{{ID: "notice-created", Stream: "group:notice-group", Seq: 1, Time: time.Now(), Type: group.Created, Scope: event.Scope{Group: "notice-group"}, Payload: body}}, Scope: event.Scope{Group: "notice-group"}, Notice: &group.Notice{Kind: "question", Text: "Reply needed", To: []event.ID{"owner"}}}); err != nil {
		t.Fatal(err)
	}
	select {
	case fact := <-changes:
		if fact.Scope.Group != "notice-group" || fact.Stream != event.Stream("inbox:"+cloud.Identity(peer.Credentials())) {
			t.Fatalf("notice=%+v", fact)
		}
	case <-ctx.Done():
		t.Fatal(ctx.Err())
	}
	if err := e.DisconnectCloud(ctx); err != nil {
		t.Fatal(err)
	}
	if len(peer.Published) != 0 {
		t.Fatal("the device echoed its inbox notice to the host")
	}
}

func TestCloudEndpointChangeDoesNotUploadThePreviousHostsEvents(t *testing.T) {
	ctx, cancel := context.WithTimeout(t.Context(), 5*time.Second)
	defer cancel()
	first, second := testcloud.New(t), testcloud.New(t)
	storage := memory.New()
	if err := storage.Append(ctx, []event.Event{{ID: "private-event", Stream: "session:previous-host", Seq: 1, Time: time.Now(), Type: engine.DeviceInterrupted, Scope: event.Scope{Group: "previous-group"}, Payload: json.RawMessage(`{}`)}}); err != nil {
		t.Fatal(err)
	}
	if err := storage.Put(ctx, store.Doc{Kind: "cloud-stream", Key: "session:previous-host", Body: []byte(`0`), Meta: map[string]string{"host": cloud.Identity(first.Credentials())}}); err != nil {
		t.Fatal(err)
	}
	e, err := engine.New(engine.Deps{Store: storage, Workdir: t.TempDir()})
	if err != nil {
		t.Fatal(err)
	}
	defer e.Close()
	if err := e.ConnectCloud(ctx, second.Credentials()); err != nil {
		t.Fatal(err)
	}
	if err := e.DisconnectCloud(ctx); err != nil {
		t.Fatal(err)
	}
	if len(second.Published) != 0 {
		t.Fatal("another endpoint received the previous host's events")
	}
}

func TestRecoveryLeavesTheHostsRunningSessionUntouched(t *testing.T) {
	ctx := t.Context()
	storage := memory.New()
	groupBody, _ := json.Marshal(group.State{Group: group.Group{ID: "host-group", Kind: group.KindCloud}})
	scope := event.Scope{Group: "host-group", Session: "host-session"}
	sessionBody, _ := json.Marshal(session.State{ID: scope.Session, Scope: scope, Status: session.Idle})
	facts := []event.Event{
		{ID: "host-created", Stream: "group:host-group", Seq: 1, Time: time.Now(), Type: group.Created, Scope: event.Scope{Group: scope.Group}, Payload: groupBody},
		{ID: "session-created", Stream: "session:host-session", Seq: 1, Time: time.Now(), Type: session.Created, Scope: scope, Payload: sessionBody},
		{ID: "session-running", Stream: "session:host-session", Seq: 2, Time: time.Now(), Type: "turn.started", Scope: scope, Payload: json.RawMessage(`{}`)},
	}
	if err := storage.Append(ctx, facts); err != nil {
		t.Fatal(err)
	}
	if err := storage.Put(ctx, store.Doc{Kind: "cloud-group", Key: string(scope.Group), Body: []byte(`{}`), Meta: map[string]string{"host": "remote"}}); err != nil {
		t.Fatal(err)
	}
	e, err := engine.New(engine.Deps{Store: storage, Workdir: t.TempDir()})
	if err != nil {
		t.Fatal(err)
	}
	defer e.Close()
	if err := e.Recover(ctx); err != nil {
		t.Fatal(err)
	}
	stored, err := storage.Read(ctx, "session:host-session", 1, 0)
	if err != nil || len(stored) != 2 {
		t.Fatalf("host stream changed: %d %v", len(stored), err)
	}
}

func TestCloudDeviceToolStreamContinuesAfterRestart(t *testing.T) {
	ctx, cancel := context.WithTimeout(t.Context(), 5*time.Second)
	defer cancel()
	peer := testcloud.New(t)
	storage := memory.New()
	for round := range 2 {
		e, err := engine.New(engine.Deps{Store: storage, Workdir: t.TempDir()})
		if err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() { _ = e.Close() })
		if err := e.Recover(ctx); err != nil {
			t.Fatal(err)
		}
		if err := e.ConnectCloud(ctx, peer.Credentials()); err != nil {
			t.Fatal(err)
		}
		var facts []event.Event
		if round == 0 {
			body, _ := json.Marshal(group.State{Group: group.Group{ID: "tool-group", Kind: group.KindCloud}})
			facts = []event.Event{{ID: "tool-created", Stream: "group:tool-group", Seq: 1, Time: time.Now(), Type: group.Created, Scope: event.Scope{Group: "tool-group"}, Payload: body}}
		}
		if err := peer.Send(ctx, protocol.CloudInbound{Events: facts, ToolCall: &protocol.DeviceToolCall{Scope: event.Scope{Group: "tool-group"}, Call: tool.Call{ID: "write", Name: "write_file", Input: json.RawMessage(`{}`)}}}); err != nil {
			t.Fatal(err)
		}
		for {
			select {
			case fact := <-peer.Published:
				if fact.Type != tool.Completed {
					continue
				}
				if fact.Seq != uint64((round+1)*2) {
					t.Fatalf("sequence=%d", fact.Seq)
				}
			case <-ctx.Done():
				t.Fatal(ctx.Err())
			}
			break
		}
		if err := e.Shutdown(ctx); err != nil {
			t.Fatal(err)
		}
	}
}

func TestCloudLiveUploadResumesAfterItsSubscriberFallsBehind(t *testing.T) {
	ctx, cancel := context.WithTimeout(t.Context(), 7*time.Second)
	defer cancel()
	peer := testcloud.New(t)
	storage := memory.New()
	if err := storage.Put(ctx, store.Doc{Kind: "cloud-stream", Key: "session:live", Body: []byte(`0`), Meta: map[string]string{"host": cloud.Identity(peer.Credentials())}}); err != nil {
		t.Fatal(err)
	}
	e, err := engine.New(engine.Deps{Store: storage, Workdir: t.TempDir()})
	if err != nil {
		t.Fatal(err)
	}
	defer e.Close()
	if err := e.ConnectCloud(ctx, peer.Credentials()); err != nil {
		t.Fatal(err)
	}
	changes, stop := e.Bus.Subscribe(event.Filter{Types: []event.Type{group.Created}})
	defer stop()
	body, _ := json.Marshal(group.State{Group: group.Group{ID: "live-group", Kind: group.KindCloud}})
	if err := peer.Send(ctx, protocol.CloudInbound{Events: []event.Event{{ID: "live-created", Stream: "group:live-group", Seq: 1, Time: time.Now(), Type: group.Created, Scope: event.Scope{Group: "live-group"}, Payload: body}}}); err != nil {
		t.Fatal(err)
	}
	select {
	case <-changes:
	case <-ctx.Done():
		t.Fatal(ctx.Err())
	}
	peer.Paused.Store(true)
	peer.Disconnect()
	delta := event.Event{Stream: "session:live", Scope: event.Scope{Group: "live-group", Session: "live"}, Type: session.MessageDelta, Payload: json.RawMessage(`{"kind":"text","text":"before"}`)}
	for range 2500 {
		if _, err := e.Bus.Publish(ctx, delta); err != nil {
			t.Fatal(err)
		}
	}
	peer.Paused.Store(false)
	delta.Payload = json.RawMessage(`{"kind":"text","text":"after"}`)
	timer := time.NewTicker(100 * time.Millisecond)
	defer timer.Stop()
	for {
		select {
		case <-timer.C:
			if _, err := e.Bus.Publish(ctx, delta); err != nil {
				t.Fatal(err)
			}
		case fact := <-peer.Published:
			if string(fact.Payload) == string(delta.Payload) {
				return
			}
		case <-ctx.Done():
			t.Fatal("live upload did not resume after the subscription overflow")
		}
	}
}

func TestCloudShutdownUploadsInterruptedClaimsBeforeClosingTheLink(t *testing.T) {
	for _, early := range []bool{false, true} {
		name := "shutdown"
		if early {
			name = "cancel before startup"
		}
		t.Run(name, func(t *testing.T) {
			ctx, cancel := context.WithTimeout(t.Context(), 10*time.Second)
			defer cancel()
			entered := make(chan struct{})
			provider := fake.New(t, fake.Reply{Hold: make(chan struct{}), Expect: func(model.Request) error { close(entered); return nil }})
			peer := testcloud.New(t)
			directory := t.TempDir()
			storage := memory.New()
			e, err := engine.New(engine.Deps{Store: storage, Workdir: directory, Cloud: cloud.NewWebSocket(), SentinelInterval: 5 * time.Millisecond, Providers: map[string]model.Provider{"fake": provider}})
			if err != nil {
				t.Fatal(err)
			}
			defer e.Close()
			p := agent.DefaultWorker()
			p.ID = "worker-profile"
			p.Model.Provider = "fake"
			if _, err = e.SaveAgent(ctx, "owner", p); err != nil {
				t.Fatal(err)
			}
			_, err = e.Groups.Create(ctx, group.Group{ID: "source", Kind: group.KindLocal, Name: "Source", Leader: "leader", Project: group.Project{Directory: directory}}, []group.Member{{ID: "worker", Name: "Worker", Kind: group.MemberAgent, AgentRole: group.AgentWorker, Agent: p.ID}, {ID: "leader", Name: "Leader", Kind: group.MemberAgent, AgentRole: group.AgentLeader, Agent: "builtin-leader"}})
			if err != nil {
				t.Fatal(err)
			}
			if err = e.ConnectCloud(ctx, peer.Credentials()); err != nil {
				t.Fatal(err)
			}
			claim := task.Claim{ID: "shutdown-claim", Task: "shutdown-task", Member: "worker", Session: "shutdown-session", Status: task.ClaimActive}
			state := group.State{Group: group.Group{ID: "shutdown-group", Kind: group.KindCloud, Name: "Cloud"}, Members: []group.Member{{ID: "worker", Kind: group.MemberAgent, AgentRole: group.AgentWorker}}}
			card := task.Card{ID: claim.Task, Group: state.Group.ID, Workspace: "none", Title: "Wait", Status: task.Running, Claims: []task.Claim{claim}}
			stateBody, _ := json.Marshal(state)
			cardBody, _ := json.Marshal(card)
			facts := []event.Event{{ID: "shutdown-created", Stream: "group:shutdown-group", Seq: 1, Time: time.Now(), Type: group.Created, Scope: event.Scope{Group: state.Group.ID}, Payload: stateBody}, {ID: "shutdown-started", Stream: "group:shutdown-group", Seq: 2, Time: time.Now(), Type: task.Started, Scope: event.Scope{Group: state.Group.ID, Task: card.ID}, Payload: cardBody}}
			facts[1].Actor = event.Actor{Kind: event.ActorAgent, ID: claim.Member}
			facts[1].Time = time.Now().Add(-2 * time.Second)
			incoming := protocol.CloudInbound{Events: facts, Assignment: &protocol.DeviceAssignment{SourceGroup: "source", Member: "worker", Claim: claim, Session: claim.Session, Scope: event.Scope{Group: card.Group, Task: card.ID}, Packet: "Wait."}}
			if early {
				incoming.Cancel = &claim.ID
			}
			if err = peer.Send(ctx, incoming); err != nil {
				t.Fatal(err)
			}
			if early {
				for {
					select {
					case <-entered:
						t.Fatal("cancelled claim started a model")
					case fact := <-peer.Published:
						if fact.Type == engine.DeviceInterrupted {
							return
						}
					case <-ctx.Done():
						t.Fatal(ctx.Err())
					}
				}
			}
			select {
			case <-entered:
			case <-ctx.Done():
				t.Fatal(ctx.Err())
			}
			select {
			case <-time.After(50 * time.Millisecond):
			case <-ctx.Done():
				t.Fatal(ctx.Err())
			}
			current, err := e.Tasks.Get(ctx, card.ID)
			if err != nil || current.Status != task.Running {
				t.Fatalf("local patrol changed cloud task=%+v %v", current, err)
			}
			if err = e.Shutdown(ctx); err != nil {
				t.Fatal(err)
			}
			for {
				select {
				case fact := <-peer.Published:
					if fact.Type != engine.DeviceInterrupted {
						continue
					}
					got, err := event.Decode[task.Claim](fact)
					if err != nil || got.ID != claim.ID || got.Status != task.ClaimInterrupted {
						t.Fatalf("interrupted=%+v %v", got, err)
					}
					if status := e.CloudStatus(); status.Online {
						t.Fatal("device link remained open")
					}
					return
				default:
					t.Fatal("shutdown returned before uploading the interrupted claim")
				}
			}
		})
	}
}

func TestCloudCodeToolReturnsSandboxedReadsAndRejectsWrites(t *testing.T) {
	ctx, cancel := context.WithTimeout(t.Context(), 60*time.Second)
	defer cancel()
	directory := t.TempDir()
	binary := os.Getenv("MERAK_TEST_BINARY")
	if binary == "" {
		binary = filepath.Join(t.TempDir(), "merak.exe")
		command := exec.CommandContext(ctx, "go", "build", "-o", binary, "../cmd/merak")
		if output, err := command.CombinedOutput(); err != nil {
			t.Fatalf("build=%s %v", output, err)
		}
	}
	if err := os.WriteFile(filepath.Join(directory, "README.md"), []byte("checkout content"), 0600); err != nil {
		t.Fatal(err)
	}
	peer := testcloud.New(t)
	e, err := engine.New(engine.Deps{Workdir: directory, MCPCommand: binary, Cloud: cloud.NewWebSocket()})
	if err != nil {
		t.Fatal(err)
	}
	defer e.Close()
	_, err = e.Groups.Create(ctx, group.Group{ID: "source", Kind: group.KindLocal, Name: "Source", Leader: "reader", Project: group.Project{Directory: directory}}, []group.Member{{ID: "reader", Name: "Reader", Kind: group.MemberAgent, AgentRole: group.AgentLeader, Agent: "builtin-leader"}})
	if err != nil {
		t.Fatal(err)
	}
	if err = e.ConnectCloud(ctx, peer.Credentials()); err != nil {
		t.Fatal(err)
	}
	stateBody, _ := json.Marshal(group.State{Group: group.Group{ID: "remote", Kind: group.KindCloud, Name: "Remote"}})
	if err = peer.Send(ctx, protocol.CloudInbound{Events: []event.Event{{ID: "remote-created", Stream: "group:remote", Seq: 1, Time: time.Now(), Type: group.Created, Scope: event.Scope{Group: "remote"}, Payload: stateBody}}}); err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{"read_file", "write_file"} {
		if err = peer.Send(ctx, protocol.CloudInbound{ToolCall: &protocol.DeviceToolCall{SourceGroup: "source", Member: "reader", Scope: event.Scope{Group: "remote"}, Call: tool.Call{ID: name, Name: name, Input: json.RawMessage(`{"path":"README.md"}`)}}}); err != nil {
			t.Fatal(err)
		}
		completed := false
		for !completed {
			select {
			case fact := <-peer.Published:
				if fact.Type != tool.Completed {
					continue
				}
				completion, err := event.Decode[tool.Completion](fact)
				if err != nil {
					t.Fatal(err)
				}
				if completion.CallID != name {
					t.Fatalf("completion=%+v", completion)
				}
				if name == "write_file" {
					if !completion.IsError || completion.Code != "MRK-5002" {
						t.Fatalf("write=%+v", completion)
					}
				} else {
					status, err := e.SandboxStatus(ctx, directory, permission.ModeAsk)
					if err != nil {
						t.Fatal(err)
					}
					if status.Available {
						if completion.IsError || len(completion.Parts) != 1 || completion.Parts[0].Text != `{"lines":1,"path":"README.md"}` {
							t.Fatalf("read=%+v", completion)
						}
					} else if !completion.IsError || completion.Code != "MRK-5004" {
						t.Fatalf("unavailable sandbox=%+v", completion)
					}
				}
				completed = true
			case <-ctx.Done():
				t.Fatal(ctx.Err())
			}
		}
	}
}

func TestCloudAssignmentWaitsForApprovalAndUploadsTheReport(t *testing.T) {
	ctx, cancel := context.WithTimeout(t.Context(), 15*time.Second)
	defer cancel()
	peer := testcloud.New(t)
	storage := memory.New()
	directory := t.TempDir()
	replies := []fake.Reply{
		{Text: "Working on the checkout.", Calls: []model.ToolCall{{ID: "write", Name: "write_file", Input: json.RawMessage(`{"path":"result.txt","content":"approved"}`)}}},
		{Calls: []model.ToolCall{{ID: "human-question", Name: "ask_user", Input: json.RawMessage(`{"text":"Which result?"}`)}}},
		{Calls: []model.ToolCall{{ID: "leader-question", Name: "ask_leader", Input: json.RawMessage(`{"text":"May I report?"}`)}}},
		{Calls: []model.ToolCall{{ID: "report", Name: "submit_report", Input: json.RawMessage(`{"verdict":"done","summary":"Finished","artifacts":[],"checks":[]}`)}}},
	}
	provider := fake.New(t, append(replies, replies...)...)
	e, err := engine.New(engine.Deps{Store: storage, Workdir: directory, Cloud: cloud.NewWebSocket(), Providers: map[string]model.Provider{provider.Name(): provider}})
	if err != nil {
		t.Fatal(err)
	}
	defer e.Close()
	p := agent.DefaultWorker()
	p.ID = "local-profile"
	p.Model.Provider = provider.Name()
	p.Mode = permission.ModeAsk
	saved, err := e.SaveAgent(ctx, "owner", p)
	if err != nil {
		t.Fatal(err)
	}
	_, err = e.Groups.Create(ctx, group.Group{ID: "local", Kind: group.KindLocal, Name: "Local", Leader: "leader", Project: group.Project{Directory: directory}}, []group.Member{{ID: "worker", Name: "Worker", Kind: group.MemberAgent, AgentRole: group.AgentWorker, Agent: saved.ID}, {ID: "leader", Name: "Leader", Kind: group.MemberAgent, AgentRole: group.AgentLeader, Agent: "builtin-leader"}})
	if err != nil {
		t.Fatal(err)
	}
	if err = e.ConnectCloud(ctx, peer.Credentials()); err != nil {
		t.Fatal(err)
	}
	claim := task.Claim{ID: "cloud-claim", Task: "cloud-task", Member: "worker", Session: "cloud-session", Status: task.ClaimActive}
	state := group.State{Group: group.Group{ID: "cloud-group", Kind: group.KindCloud, Name: "Cloud", Leader: "cloud-leader"}, Members: []group.Member{{ID: "worker", Kind: group.MemberAgent, AgentRole: group.AgentWorker, Agent: "not-a-local-profile"}}}
	card := task.Card{ID: claim.Task, Group: state.Group.ID, Title: "Write result", Workspace: "folder", Claims: []task.Claim{claim}, Status: task.Running}
	stateBody, _ := json.Marshal(state)
	cardBody, _ := json.Marshal(card)
	facts := []event.Event{{ID: "cloud-created", Stream: "group:cloud-group", Seq: 1, Time: time.Now(), Type: group.Created, Scope: event.Scope{Group: state.Group.ID}, Payload: stateBody}, {ID: "cloud-started", Stream: "group:cloud-group", Seq: 2, Time: time.Now(), Type: task.Started, Scope: event.Scope{Group: state.Group.ID, Task: card.ID}, Payload: cardBody}}
	if err = peer.Send(ctx, protocol.CloudInbound{Events: facts, Assignment: &protocol.DeviceAssignment{SourceGroup: "local", Member: "worker", Claim: claim, Session: claim.Session, Scope: event.Scope{Group: card.Group, Task: card.ID}, Packet: "Write result.txt, then report."}}); err != nil {
		t.Fatal(err)
	}
	approved := false
	questions := 0
	deltas := 0
	reports := 0
	for {
		select {
		case fact := <-peer.Published:
			if fact.Type == "message.delta" {
				deltas++
			}
			if fact.Type == question.Asked || fact.Type == group.MemberAsked {
				questions++
				if err := peer.Send(ctx, protocol.CloudInbound{QuestionReply: &protocol.DeviceAnswer{QuestionReplyParams: protocol.QuestionReplyParams{Request: fact.ID, Text: "Proceed"}, Human: "owner"}}); err != nil {
					t.Fatal(err)
				}
			}
			if fact.Type == permission.Requested {
				if approved {
					t.Fatal("duplicate approval")
				}
				approved = true
				if err = peer.Send(ctx, protocol.CloudInbound{Reply: &protocol.DeviceReply{PermissionReplyParams: protocol.PermissionReplyParams{Request: fact.ID, Decision: permission.Allow}, Human: "owner"}}); err != nil {
					t.Fatal(err)
				}
			}
			if fact.Type == "claim.reported" {
				if !approved {
					facts, _ := storage.Find(ctx, store.Query{Scope: event.Scope{Session: claim.Session}})
					t.Fatalf("worker skipped approval: %+v, history=%+v", string(fact.Payload), facts)
				}
				report, err := event.Decode[task.Report](fact)
				if err != nil || report.Claim != claim.ID || report.Verdict != task.VerdictDone {
					t.Fatalf("report=%+v %v", report, err)
				}
				hosted, err := storage.Read(ctx, "group:cloud-group", 1, 0)
				if err != nil || len(hosted) != 2+reports {
					t.Fatalf("local execution changed the host stream: %d %v", len(hosted), err)
				}
				sessions, err := storage.Find(ctx, store.Query{Scope: event.Scope{Session: claim.Session}, Types: []event.Type{permission.Replied}})
				if err != nil || len(sessions) != 1+reports {
					t.Fatalf("approval=%+v %v", sessions, err)
				}
				if reports == 0 {
					reports++
					approved = false
					rework := facts[1]
					rework.ID = "cloud-rework"
					rework.Seq = 3
					rework.Time = time.Now()
					if err = peer.Send(ctx, protocol.CloudInbound{Events: []event.Event{rework}, Assignment: &protocol.DeviceAssignment{SourceGroup: "local", Member: "worker", Claim: claim, Session: claim.Session, Scope: event.Scope{Group: card.Group, Task: card.ID}, Packet: "Revise the result and report again."}}); err != nil {
						t.Fatal(err)
					}
					continue
				}
				if questions != 4 {
					t.Fatalf("questions=%d", questions)
				}
				if deltas == 0 {
					t.Fatal("device did not publish live message deltas")
				}
				return
			}
		case <-ctx.Done():
			t.Fatal(ctx.Err())
		}
	}
}

func TestCloudConnectionAnnouncesRegisteredMembersAndForwardsCreation(t *testing.T) {
	ctx, cancel := context.WithTimeout(t.Context(), 5*time.Second)
	defer cancel()
	peer := testcloud.New(t)
	peer.Handle = func(request protocol.Message) (any, error) {
		return group.Group{ID: "cloud-group", Kind: group.KindCloud, Name: "Cloud"}, nil
	}
	e, err := engine.New(engine.Deps{Workdir: t.TempDir(), Cloud: cloud.NewWebSocket()})
	if err != nil {
		t.Fatal(err)
	}
	defer e.Close()
	_, err = e.Groups.Create(ctx, group.Group{ID: "local", Kind: group.KindLocal, Name: "Local", Leader: "leader", Project: group.Project{Directory: t.TempDir()}}, []group.Member{{ID: "worker", Name: "Worker", Kind: group.MemberAgent, AgentRole: group.AgentWorker, Agent: "builtin-worker"}, {ID: "leader", Name: "Leader", Kind: group.MemberAgent, AgentRole: group.AgentLeader, Agent: "builtin-leader"}})
	if err != nil {
		t.Fatal(err)
	}
	if err = e.ConnectCloud(ctx, peer.Credentials()); err != nil {
		t.Fatal(err)
	}
	select {
	case members := <-peer.Announced:
		if len(members) != 2 || members[0].ID != event.ID("worker") || members[0].Summary == "" {
			t.Fatalf("members=%+v", members)
		}
	case <-ctx.Done():
		t.Fatal(ctx.Err())
	}
	created, err := createGroup(t, e, ctx, group.Group{Kind: group.KindCloud, Name: "Cloud"}, nil, nil)
	if err != nil || created.ID != "cloud-group" {
		t.Fatalf("created=%+v %v", created, err)
	}
	select {
	case request := <-peer.Requests:
		var params protocol.GroupCreateParams
		if json.Unmarshal(request.Params, &params) != nil || request.Method != "group.create" || params.Kind != group.KindCloud {
			t.Fatalf("request=%+v", request)
		}
	case <-ctx.Done():
		t.Fatal(ctx.Err())
	}
}
