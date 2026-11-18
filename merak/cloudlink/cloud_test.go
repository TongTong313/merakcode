package cloudlink_test

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"sync/atomic"
	"testing"
	"time"

	"github.com/TongTong313/merakcode/merak/cloudlink"
	"github.com/TongTong313/merakcode/merak/engine"
	"github.com/TongTong313/merakcode/merak/engine/agent/definition"
	"github.com/TongTong313/merakcode/merak/engine/agent/model"
	"github.com/TongTong313/merakcode/merak/engine/agent/model/fake"
	"github.com/TongTong313/merakcode/merak/engine/agent/permission"
	"github.com/TongTong313/merakcode/merak/engine/agent/question"
	"github.com/TongTong313/merakcode/merak/engine/agent/session"
	"github.com/TongTong313/merakcode/merak/engine/agent/tool"
	"github.com/TongTong313/merakcode/merak/engine/collab/group"
	"github.com/TongTong313/merakcode/merak/engine/collab/remote"
	"github.com/TongTong313/merakcode/merak/engine/collab/task"
	"github.com/TongTong313/merakcode/merak/engine/collab/wire"
	"github.com/TongTong313/merakcode/merak/engine/infra/event"
	"github.com/TongTong313/merakcode/merak/engine/infra/store"
	"github.com/TongTong313/merakcode/merak/protocol"
	"github.com/TongTong313/merakcode/merak/storage/memory"
	"github.com/TongTong313/merakcode/merak/testkit/enginetest"
	"github.com/TongTong313/merakcode/merak/testkit/testcloud"
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
	deps := enginetest.Deps(t)
	deps.NewLink = func() wire.Link { return cloudlink.NewWebSocket() }
	deps.Workdir = t.TempDir()
	deps.Store = storage
	e, err := engine.New(deps)
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
		if !errors.Is(err, wire.ErrNoCloud) || received.Load() != 0 {
			t.Fatalf("switched request=%v new account requests=%d", err, received.Load())
		}
	case <-ctx.Done():
		t.Fatal(ctx.Err())
	}
}

func TestCloudGroupRequiresAnAccountWhileLocalGroupsRemainAvailable(t *testing.T) {
	deps2 := enginetest.Deps(t)
	deps2.NewLink = func() wire.Link { return cloudlink.NewWebSocket() }
	deps2.Workdir = t.TempDir()
	e, err := engine.New(deps2)
	if err != nil {
		t.Fatal(err)
	}
	defer e.Close()
	_, err = enginetest.CreateGroup(t, e, t.Context(), group.Group{Kind: "cloud", Name: "Cloud"}, nil, nil)
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
	deps3 := enginetest.Deps(t)
	deps3.NewLink = func() wire.Link { return cloudlink.NewWebSocket() }
	deps3.Workdir = t.TempDir()
	e, err := engine.New(deps3)
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
	deps4 := enginetest.Deps(t)
	deps4.NewLink = func() wire.Link { return cloudlink.NewWebSocket() }
	deps4.Workdir = t.TempDir()
	e, err := engine.New(deps4)
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
		var read wire.EventsReadParams
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
	deps5 := enginetest.Deps(t)
	deps5.NewLink = func() wire.Link { return cloudlink.NewWebSocket() }
	deps5.Workdir = t.TempDir()
	e, err := engine.New(deps5)
	if err != nil {
		t.Fatal(err)
	}
	defer e.Close()
	if err = e.ConnectCloud(ctx, peer.Credentials()); err != nil {
		t.Fatal(err)
	}
	events, stop := e.Subscribe(event.Filter{Scope: event.Scope{Group: "history"}})
	defer stop()
	if err = peer.Send(ctx, wire.CloudInbound{Events: []event.Event{facts[2]}}); err != nil {
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
	a := wire.DeviceAssignment{Cause: "recovered-start", SourceGroup: "source", Member: "worker", Claim: task.Claim{ID: "recovered-claim", Task: "recovered-task", Member: "worker", Session: "recovered-session", Status: task.ClaimActive}, Session: "recovered-session", Scope: event.Scope{Group: "recovered-group", Task: "recovered-task", Session: "recovered-session"}, Packet: "Old assignment"}
	body, _ := json.Marshal(map[string]any{"assignment": a, "status": "active", "host": wire.Identity(peer.Credentials())})
	if err := storage.Put(ctx, store.Doc{Kind: "device-run", Key: string(a.Claim.ID), Body: body}); err != nil {
		t.Fatal(err)
	}
	deps6 := enginetest.Deps(t)
	deps6.NewLink = func() wire.Link { return cloudlink.NewWebSocket() }
	deps6.Store = storage
	deps6.Workdir = t.TempDir()
	e, err := engine.New(deps6)
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
			if fact.Type != remote.DeviceInterrupted {
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
	deps7 := enginetest.Deps(t)
	deps7.NewLink = func() wire.Link { return cloudlink.NewWebSocket() }
	deps7.Workdir = t.TempDir()
	e, err := engine.New(deps7)
	if err != nil {
		t.Fatal(err)
	}
	defer e.Close()
	if err := e.ConnectCloud(ctx, peer.Credentials()); err != nil {
		t.Fatal(err)
	}
	events, stop := e.Subscribe(event.Filter{Types: []event.Type{group.Created}})
	defer stop()
	body, _ := json.Marshal(group.State{Group: group.Group{ID: "account-group", Kind: group.KindCloud}})
	if err := peer.Send(ctx, wire.CloudInbound{Events: []event.Event{{ID: "account-created", Stream: "group:account-group", Seq: 1, Time: time.Now(), Type: group.Created, Scope: event.Scope{Group: "account-group"}, Payload: body}}}); err != nil {
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
	if !handled || !errors.Is(err, wire.ErrNoCloud) {
		t.Fatalf("cross-account forwarding: handled=%v error=%v", handled, err)
	}
}

func TestCloudNoticeReachesTheInboxWithoutBeingUploaded(t *testing.T) {
	ctx, cancel := context.WithTimeout(t.Context(), 3*time.Second)
	defer cancel()
	peer := testcloud.New(t)
	deps8 := enginetest.Deps(t)
	deps8.NewLink = func() wire.Link { return cloudlink.NewWebSocket() }
	deps8.Workdir = t.TempDir()
	e, err := engine.New(deps8)
	if err != nil {
		t.Fatal(err)
	}
	defer e.Close()
	if err := e.ConnectCloud(ctx, peer.Credentials()); err != nil {
		t.Fatal(err)
	}
	changes, stop := e.Subscribe(event.Filter{Types: []event.Type{group.NoticeSent}})
	defer stop()
	body, _ := json.Marshal(group.State{Group: group.Group{ID: "notice-group", Kind: group.KindCloud}})
	if err := peer.Send(ctx, wire.CloudInbound{Events: []event.Event{{ID: "notice-created", Stream: "group:notice-group", Seq: 1, Time: time.Now(), Type: group.Created, Scope: event.Scope{Group: "notice-group"}, Payload: body}}, Scope: event.Scope{Group: "notice-group"}, Notice: &group.Notice{Kind: "question", Text: "Reply needed", To: []event.ID{"owner"}}}); err != nil {
		t.Fatal(err)
	}
	select {
	case fact := <-changes:
		if fact.Scope.Group != "notice-group" || fact.Stream != event.Stream("inbox:"+wire.Identity(peer.Credentials())) {
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
	if err := storage.Append(ctx, []event.Event{{ID: "private-event", Stream: "session:previous-host", Seq: 1, Time: time.Now(), Type: remote.DeviceInterrupted, Scope: event.Scope{Group: "previous-group"}, Payload: json.RawMessage(`{}`)}}); err != nil {
		t.Fatal(err)
	}
	if err := storage.Put(ctx, store.Doc{Kind: "cloud-stream", Key: "session:previous-host", Body: []byte(`0`), Meta: map[string]string{"host": wire.Identity(first.Credentials())}}); err != nil {
		t.Fatal(err)
	}
	deps9 := enginetest.Deps(t)
	deps9.NewLink = func() wire.Link { return cloudlink.NewWebSocket() }
	deps9.Store = storage
	deps9.Workdir = t.TempDir()
	e, err := engine.New(deps9)
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
	deps10 := enginetest.Deps(t)
	deps10.NewLink = func() wire.Link { return cloudlink.NewWebSocket() }
	deps10.Store = storage
	deps10.Workdir = t.TempDir()
	e, err := engine.New(deps10)
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
		deps11 := enginetest.Deps(t)
		deps11.NewLink = func() wire.Link { return cloudlink.NewWebSocket() }
		deps11.Store = storage
		deps11.Workdir = t.TempDir()
		e, err := engine.New(deps11)
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
		if err := peer.Send(ctx, wire.CloudInbound{Events: facts, ToolCall: &wire.DeviceToolCall{Scope: event.Scope{Group: "tool-group"}, Call: tool.Call{ID: "write", Name: "write_file", Input: json.RawMessage(`{}`)}}}); err != nil {
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
	if err := storage.Put(ctx, store.Doc{Kind: "cloud-stream", Key: "session:live", Body: []byte(`0`), Meta: map[string]string{"host": wire.Identity(peer.Credentials())}}); err != nil {
		t.Fatal(err)
	}
	deps12 := enginetest.Deps(t)
	deps12.NewLink = func() wire.Link { return cloudlink.NewWebSocket() }
	deps12.Store = storage
	deps12.Workdir = t.TempDir()
	e, err := engine.New(deps12)
	if err != nil {
		t.Fatal(err)
	}
	defer e.Close()
	if err := e.ConnectCloud(ctx, peer.Credentials()); err != nil {
		t.Fatal(err)
	}
	changes, stop := e.Subscribe(event.Filter{Types: []event.Type{group.Created}})
	defer stop()
	body, _ := json.Marshal(group.State{Group: group.Group{ID: "live-group", Kind: group.KindCloud}})
	if err := peer.Send(ctx, wire.CloudInbound{Events: []event.Event{{ID: "live-created", Stream: "group:live-group", Seq: 1, Time: time.Now(), Type: group.Created, Scope: event.Scope{Group: "live-group"}, Payload: body}}}); err != nil {
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
		if _, err := e.Publish(ctx, delta); err != nil {
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
			if _, err := e.Publish(ctx, delta); err != nil {
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
			deps13 := enginetest.Deps(t)
			deps13.NewLink = func() wire.Link { return cloudlink.NewWebSocket() }
			deps13.Store = storage
			deps13.Workdir = directory
			deps13.SentinelInterval = 5 * time.Millisecond
			deps13.Providers = map[string]model.Provider{"fake": provider}
			e, err := engine.New(deps13)
			if err != nil {
				t.Fatal(err)
			}
			defer e.Close()
			p := definition.DefaultMerakCode()
			p.ID = "worker-profile"
			p.Model.Provider = "fake"
			if _, err = e.SaveAgent(ctx, "owner", p); err != nil {
				t.Fatal(err)
			}
			_, err = e.CreateGroup(ctx, group.Group{ID: "source", Kind: group.KindLocal, Name: "Source", Leader: "leader", Project: group.Project{Directory: directory}}, []group.Member{{ID: "worker", Name: "Worker", Kind: group.MemberAgent, AgentRole: group.AgentWorker, Agent: p.ID}, {ID: "leader", Name: "Leader", Kind: group.MemberAgent, AgentRole: group.AgentLeader, Agent: "builtin-merakcode"}})
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
			incoming := wire.CloudInbound{Events: facts, Assignment: &wire.DeviceAssignment{SourceGroup: "source", Member: "worker", Claim: claim, Session: claim.Session, Scope: event.Scope{Group: card.Group, Task: card.ID}, Packet: "Wait."}}
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
						if fact.Type == remote.DeviceInterrupted {
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
			current, err := e.Task(ctx, card.ID)
			if err != nil || current.Status != task.Running {
				t.Fatalf("local patrol changed cloud task=%+v %v", current, err)
			}
			if err = e.Shutdown(ctx); err != nil {
				t.Fatal(err)
			}
			for {
				select {
				case fact := <-peer.Published:
					if fact.Type != remote.DeviceInterrupted {
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
		command := exec.CommandContext(ctx, "go", "build", "-o", binary, "github.com/TongTong313/merakcode/merak/cmd/merak")
		if output, err := command.CombinedOutput(); err != nil {
			t.Fatalf("build=%s %v", output, err)
		}
	}
	if err := os.WriteFile(filepath.Join(directory, "README.md"), []byte("checkout content"), 0600); err != nil {
		t.Fatal(err)
	}
	peer := testcloud.New(t)
	deps14 := enginetest.Deps(t)
	deps14.NewLink = func() wire.Link { return cloudlink.NewWebSocket() }
	deps14.Workdir = directory
	deps14.MCPCommand = binary
	e, err := engine.New(deps14)
	if err != nil {
		t.Fatal(err)
	}
	defer e.Close()
	_, err = e.CreateGroup(ctx, group.Group{ID: "source", Kind: group.KindLocal, Name: "Source", Leader: "reader", Project: group.Project{Directory: directory}}, []group.Member{{ID: "reader", Name: "Reader", Kind: group.MemberAgent, AgentRole: group.AgentLeader, Agent: "builtin-merakcode"}})
	if err != nil {
		t.Fatal(err)
	}
	if err = e.ConnectCloud(ctx, peer.Credentials()); err != nil {
		t.Fatal(err)
	}
	stateBody, _ := json.Marshal(group.State{Group: group.Group{ID: "remote", Kind: group.KindCloud, Name: "Remote"}})
	if err = peer.Send(ctx, wire.CloudInbound{Events: []event.Event{{ID: "remote-created", Stream: "group:remote", Seq: 1, Time: time.Now(), Type: group.Created, Scope: event.Scope{Group: "remote"}, Payload: stateBody}}}); err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{"read_file", "write_file"} {
		if err = peer.Send(ctx, wire.CloudInbound{ToolCall: &wire.DeviceToolCall{SourceGroup: "source", Member: "reader", Scope: event.Scope{Group: "remote"}, Call: tool.Call{ID: name, Name: name, Input: json.RawMessage(`{"path":"README.md"}`)}}}); err != nil {
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
	deps15 := enginetest.Deps(t)
	deps15.NewLink = func() wire.Link { return cloudlink.NewWebSocket() }
	deps15.Store = storage
	deps15.Workdir = directory
	deps15.Providers = map[string]model.Provider{provider.Name(): provider}
	e, err := engine.New(deps15)
	if err != nil {
		t.Fatal(err)
	}
	defer e.Close()
	p := definition.DefaultMerakCode()
	p.ID = "local-profile"
	p.Model.Provider = provider.Name()
	p.Mode = permission.ModeAsk
	saved, err := e.SaveAgent(ctx, "owner", p)
	if err != nil {
		t.Fatal(err)
	}
	_, err = e.CreateGroup(ctx, group.Group{ID: "local", Kind: group.KindLocal, Name: "Local", Leader: "leader", Project: group.Project{Directory: directory}}, []group.Member{{ID: "worker", Name: "Worker", Kind: group.MemberAgent, AgentRole: group.AgentWorker, Agent: saved.ID}, {ID: "leader", Name: "Leader", Kind: group.MemberAgent, AgentRole: group.AgentLeader, Agent: "builtin-merakcode"}})
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
	if err = peer.Send(ctx, wire.CloudInbound{Events: facts, Assignment: &wire.DeviceAssignment{SourceGroup: "local", Member: "worker", Claim: claim, Session: claim.Session, Scope: event.Scope{Group: card.Group, Task: card.ID}, Packet: "Write result.txt, then report."}}); err != nil {
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
				if err := peer.Send(ctx, wire.CloudInbound{QuestionReply: &wire.DeviceAnswer{QuestionReplyParams: wire.QuestionReplyParams{Request: fact.ID, Text: "Proceed"}, Human: "owner"}}); err != nil {
					t.Fatal(err)
				}
			}
			if fact.Type == permission.Requested {
				if approved {
					t.Fatal("duplicate approval")
				}
				approved = true
				if err = peer.Send(ctx, wire.CloudInbound{Reply: &wire.DeviceReply{PermissionReplyParams: wire.PermissionReplyParams{Request: fact.ID, Decision: permission.Allow}, Human: "owner"}}); err != nil {
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
					if err = peer.Send(ctx, wire.CloudInbound{Events: []event.Event{rework}, Assignment: &wire.DeviceAssignment{SourceGroup: "local", Member: "worker", Claim: claim, Session: claim.Session, Scope: event.Scope{Group: card.Group, Task: card.ID}, Packet: "Revise the result and report again."}}); err != nil {
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
	deps16 := enginetest.Deps(t)
	deps16.NewLink = func() wire.Link { return cloudlink.NewWebSocket() }
	deps16.Workdir = t.TempDir()
	e, err := engine.New(deps16)
	if err != nil {
		t.Fatal(err)
	}
	defer e.Close()
	_, err = e.CreateGroup(ctx, group.Group{ID: "local", Kind: group.KindLocal, Name: "Local", Leader: "leader", Project: group.Project{Directory: t.TempDir()}}, []group.Member{{ID: "worker", Name: "Worker", Kind: group.MemberAgent, AgentRole: group.AgentWorker, Agent: "builtin-merakcode"}, {ID: "leader", Name: "Leader", Kind: group.MemberAgent, AgentRole: group.AgentLeader, Agent: "builtin-merakcode"}})
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
	created, err := enginetest.CreateGroup(t, e, ctx, group.Group{Kind: group.KindCloud, Name: "Cloud"}, nil, nil)
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
