package server_test

import (
	"context"
	"encoding/json"
	"errors"
	"path/filepath"
	"reflect"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/TongTong313/merakcode/merak/cloudlink"
	"github.com/TongTong313/merakcode/merak/engine"
	"github.com/TongTong313/merakcode/merak/engine/agent/definition"
	"github.com/TongTong313/merakcode/merak/engine/agent/model"
	"github.com/TongTong313/merakcode/merak/engine/agent/model/catalog"
	"github.com/TongTong313/merakcode/merak/engine/agent/model/fake"
	"github.com/TongTong313/merakcode/merak/engine/agent/permission"
	"github.com/TongTong313/merakcode/merak/engine/agent/question"
	"github.com/TongTong313/merakcode/merak/engine/collab/group"
	"github.com/TongTong313/merakcode/merak/engine/collab/remote"
	"github.com/TongTong313/merakcode/merak/engine/collab/task"
	"github.com/TongTong313/merakcode/merak/engine/collab/wire"
	"github.com/TongTong313/merakcode/merak/engine/infra/event"
	"github.com/TongTong313/merakcode/merak/engine/infra/process"
	"github.com/TongTong313/merakcode/merak/engine/infra/sandbox"
	"github.com/TongTong313/merakcode/merak/engine/infra/store"
	"github.com/TongTong313/merakcode/merak/protocol"
	"github.com/TongTong313/merakcode/merak/server"
	"github.com/TongTong313/merakcode/merak/storage/memory"
	"github.com/TongTong313/merakcode/merak/storage/vault"
	"github.com/TongTong313/merakcode/merak/testkit/enginetest"
)

func TestRemoteConnectionListsTheOtherEnginesRegisteredMembersWithoutExposingItsToken(t *testing.T) {
	ctx, cancel := context.WithTimeout(t.Context(), 8*time.Second)
	defer cancel()
	storage := memory.New()
	dataDir := t.TempDir()
	deps := enginetest.Deps(t)
	deps.Dial = cloudlink.Dial
	deps.DataDir = dataDir
	deps.Dirs = enginetest.Dirs(t, deps.DataDir)
	deps.Workdir = t.TempDir()
	deps.Store = storage
	a, err := engine.New(deps)
	if err != nil {
		t.Fatal(err)
	}
	defer a.Close()
	deps2 := enginetest.Deps(t)
	deps2.Dial = cloudlink.Dial
	deps2.Workdir = t.TempDir()
	b, err := engine.New(deps2)
	if err != nil {
		t.Fatal(err)
	}
	defer b.Close()
	sourceProfile := definition.DefaultMerakCode()
	sourceProfile.ID, sourceProfile.Mode = "source-profile", permission.ModeTakeover
	if _, err := b.SaveAgent(ctx, "owner", sourceProfile); err != nil {
		t.Fatal(err)
	}
	if _, err := b.CreateGroup(ctx, group.Group{ID: "source", Kind: group.KindLocal, Name: "Source", Leader: "leader", Project: group.Project{Directory: t.TempDir()}}, []group.Member{{ID: "leader", Kind: group.MemberAgent, Name: "Leader", AgentRole: group.AgentLeader, Agent: "builtin-merakcode"}, {ID: "worker", Kind: group.MemberAgent, Name: "Remote worker", AgentRole: group.AgentWorker, Agent: sourceProfile.ID}}); err != nil {
		t.Fatal(err)
	}
	first, err := server.Start(a, t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer first.Close()
	second, err := server.Start(b, t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer second.Close()
	client, err := protocol.Connect(ctx, first.Info.Endpoint, first.Info.Token, protocol.HelloParams{Protocol: protocol.Version})
	if err != nil {
		t.Fatal(err)
	}
	defer client.Close()
	if err := client.Call(ctx, "remote.connect", wire.RemoteConnectParams{Endpoint: second.Info.Endpoint, Token: "wrong-token"}, nil); err == nil {
		t.Fatal("an unauthenticated remote connection succeeded")
	}
	var connected wire.RemoteConnection
	t.Cleanup(func() {
		if connected.ID != "" {
			_ = vault.New(filepath.Join(dataDir, "credentials")).Delete(context.Background(), "remote:"+string(connected.ID))
		}
	})
	if err := client.Call(ctx, "remote.connect", wire.RemoteConnectParams{Endpoint: second.Info.Endpoint, Token: second.Info.Token}, &connected); err != nil {
		t.Fatal(err)
	}
	if connected.ID == "" || len(connected.Members) != 2 || connected.Members[1].Member.Name != "Remote worker" || !connected.Members[1].Caps.Steer {
		t.Fatalf("connection=%+v", connected)
	}
	encoded, _ := json.Marshal(connected)
	var reconnected wire.RemoteConnection
	if err := client.Call(ctx, "remote.connect", wire.RemoteConnectParams{Endpoint: second.Info.Endpoint, Token: second.Info.Token}, &reconnected); err != nil || reconnected.ID != connected.ID {
		t.Fatalf("reconnecting changed the remote host identity: %s != %s (%v)", reconnected.ID, connected.ID, err)
	}
	if strings.Contains(string(encoded), second.Info.Token) {
		t.Fatal("connection response exposed the token")
	}
	alias := definition.DefaultMerakCode()
	alias.ID = "remote-profile"
	alias.Product = &definition.Product{Kind: definition.KindRemote, Remote: &definition.RemoteSource{Connection: connected.ID, Group: "source", Member: "worker"}}
	if _, err := a.SaveAgent(ctx, "owner", alias); err != nil {
		t.Fatal(err)
	}
	if _, err := a.CreateGroup(ctx, group.Group{ID: "local", Kind: group.KindLocal, Name: "Local", Leader: "leader", Project: group.Project{Directory: t.TempDir()}}, []group.Member{{ID: "leader", Name: "Leader", Kind: group.MemberAgent, AgentRole: group.AgentLeader, Agent: "builtin-merakcode"}, {ID: "alias", Name: "Remote", Kind: group.MemberAgent, AgentRole: group.AgentWorker, Agent: alias.ID}}); err != nil {
		t.Fatal(err)
	}
	var status sandbox.Status
	if err := client.Call(ctx, "sandbox.status", wire.SandboxStatusParams{Group: "local", Member: "alias"}, &status); err != nil || !status.Disabled {
		t.Fatalf("remote sandbox status did not use the source profile: %+v %v", status, err)
	}
	docs, err := storage.List(ctx, "remote-connection", "")
	if err != nil || len(docs) != 1 {
		t.Fatalf("connections=%v %v", docs, err)
	}
	doc, err := storage.Fetch(ctx, docs[0].Kind, docs[0].Key)
	if err != nil || strings.Contains(string(doc.Body), second.Info.Token) {
		t.Fatal("connection document exposed the token")
	}
	facts, err := storage.Find(ctx, store.Query{})
	encoded, _ = json.Marshal(facts)
	if err != nil || strings.Contains(string(encoded), second.Info.Token) {
		t.Fatal("event history exposed the token")
	}
}

func TestRemotePeerExecutesTheRegisteredSourceMemberInItsOwnCheckout(t *testing.T) {
	ctx, cancel := context.WithTimeout(t.Context(), 8*time.Second)
	defer cancel()
	release := make(chan struct{})
	provider := fake.New(t, fake.Reply{Hold: release, Calls: []model.ToolCall{{ID: "report", Name: "submit_report", Input: json.RawMessage(`{"verdict":"done","summary":"Remote result","artifacts":[],"checks":[]}`)}}})
	deps3 := enginetest.Deps(t)
	deps3.Dial = cloudlink.Dial
	deps3.Workdir = t.TempDir()
	deps3.Providers = map[string]model.Provider{"fake": provider}
	b, err := engine.New(deps3)
	if err != nil {
		t.Fatal(err)
	}
	defer b.Close()
	p := definition.DefaultMerakCode()
	p.ID, p.Model.Provider = "source-profile", "fake"
	if _, err := b.SaveAgent(ctx, "owner", p); err != nil {
		t.Fatal(err)
	}
	if _, err := b.CreateGroup(ctx, group.Group{ID: "source", Kind: group.KindLocal, Name: "Source", Leader: "leader", Project: group.Project{Directory: t.TempDir()}}, []group.Member{{ID: "leader", Kind: group.MemberAgent, Name: "Leader", AgentRole: group.AgentLeader, Agent: "builtin-merakcode"}, {ID: "worker", Kind: group.MemberAgent, Name: "Worker", AgentRole: group.AgentWorker, Agent: p.ID}}); err != nil {
		t.Fatal(err)
	}
	instance, err := server.Start(b, t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer instance.Close()
	client, err := protocol.Connect(ctx, instance.Info.Endpoint, instance.Info.Token, protocol.HelloParams{Protocol: protocol.Version})
	if err != nil {
		t.Fatal(err)
	}
	defer client.Close()
	if err := client.Call(ctx, "events.subscribe", event.Filter{Scope: event.Scope{Group: "host-group"}}, nil); err != nil {
		t.Fatal(err)
	}
	claim := task.Claim{ID: "remote-claim", Task: "remote-task", Session: "remote-session", Member: "remote-worker", Status: task.ClaimActive}
	state := group.State{Group: group.Group{ID: "host-group", Kind: group.KindLocal, Name: "Host", Leader: "host-leader", Project: group.Project{Directory: "not-a-local-path"}}, Members: []group.Member{{ID: "remote-worker", Kind: group.MemberAgent, AgentRole: group.AgentWorker, Agent: "private-host-profile"}}}
	card := task.Card{ID: claim.Task, Group: state.Group.ID, Title: "Remote task", Workspace: "none", Status: task.Running, Claims: []task.Claim{claim}}
	groupBody, _ := json.Marshal(state)
	cardBody, _ := json.Marshal(card)
	facts := []event.Event{{ID: "host-created", Stream: "group:host-group", Seq: 1, Time: time.Now(), Scope: event.Scope{Group: card.Group}, Type: group.Created, Payload: groupBody}, {ID: "host-started", Stream: "group:host-group", Seq: 2, Time: time.Now(), Scope: event.Scope{Group: card.Group, Task: card.ID}, Type: task.Started, Payload: cardBody}}
	params := wire.RemoteStartParams{Host: "test-host", Events: facts, Assignment: wire.DeviceAssignment{Cause: "host-started", SourceGroup: "source", Member: "worker", Claim: claim, Session: claim.Session, Scope: event.Scope{Group: card.Group, Task: card.ID}, Packet: "Report your result."}}
	var started wire.RemoteStartResult
	if err := client.Call(ctx, "remote.start", params, &started); err != nil {
		t.Fatal(err)
	}
	other, err := protocol.Connect(ctx, instance.Info.Endpoint, instance.Info.Token, protocol.HelloParams{Protocol: protocol.Version})
	if err != nil {
		t.Fatal(err)
	}
	defer other.Close()
	var repeated wire.RemoteStartResult
	if err := other.Call(ctx, "remote.start", params, &repeated); err != nil || !reflect.DeepEqual(started.Cursors, repeated.Cursors) || repeated.Completed {
		t.Fatalf("active retry changed the generation cursors: %+v %+v %v", started, repeated, err)
	}
	close(release)
	for {
		select {
		case fact := <-client.Events:
			if fact.Type != remote.DeviceReported {
				continue
			}
			report, err := event.Decode[task.Report](fact)
			if err != nil || report.Verdict != task.VerdictDone || report.Summary != "Remote result" {
				t.Fatalf("report=%+v %v", report, err)
			}
			stored, err := b.GetEvent(ctx, fact.ID)
			if err != nil || stored.Seq != fact.Seq || stored.Cause != "host-started" {
				t.Fatalf("event identity changed: %+v %v", stored, err)
			}
			return
		case <-ctx.Done():
			t.Fatal(ctx.Err())
		}
	}
}

func remoteCheckout(t *testing.T) (string, string, string) {
	t.Helper()
	checkout, remote := t.TempDir(), t.TempDir()
	run := func(dir string, args ...string) string {
		t.Helper()
		body, err := process.Command(t.Context(), dir, "git", args...).CombinedOutput()
		if err != nil {
			t.Fatalf("git %v: %s %v", args, body, err)
		}
		return strings.TrimSpace(string(body))
	}
	run(remote, "init", "--bare", "-b", "main")
	run(checkout, "init", "-b", "main")
	run(checkout, "config", "user.name", "Fixture")
	run(checkout, "config", "user.email", "fixture@example.invalid")
	run(checkout, "commit", "--allow-empty", "-m", "Initial fixture")
	run(checkout, "remote", "add", "origin", remote)
	run(checkout, "push", "origin", "main")
	return checkout, remote, run(checkout, "rev-parse", "HEAD")
}

func TestRemoteWorkerImportsOriginalEventsIntoTheAssigningEngine(t *testing.T) {
	checkout, remoteURL, base := remoteCheckout(t)
	ctx, cancel := context.WithTimeout(t.Context(), 10*time.Second)
	defer cancel()
	dataDir := t.TempDir()
	var approvals atomic.Int32
	var questions atomic.Int32
	hostStore := memory.New()
	deps4 := enginetest.Deps(t)
	deps4.Dial = cloudlink.Dial
	deps4.Store = hostStore
	deps4.DataDir = dataDir
	deps4.Dirs = enginetest.Dirs(t, deps4.DataDir)
	deps4.Workdir = t.TempDir()
	deps4.Providers = map[string]model.Provider{"leader": fake.New(t, fake.Reply{Hold: make(chan struct{})})}
	deps4.Ask = func(context.Context, permission.Request) (permission.Reply, error) {
		approvals.Add(1)
		return permission.Reply{Human: "approver", Decision: permission.Allow}, nil
	}
	deps4.AskQuestion = func(context.Context, question.Request) (question.Answer, error) {
		questions.Add(1)
		return question.Answer{Human: "owner", Text: "Continue"}, nil
	}
	a, err := engine.New(deps4)
	if err != nil {
		t.Fatal(err)
	}
	defer a.Close()
	provider := fake.New(t,
		fake.Reply{Calls: []model.ToolCall{{ID: "document", Name: "read_doc", Input: json.RawMessage(`{"key":"instructions"}`)}}},
		fake.Reply{Calls: []model.ToolCall{{ID: "write", Name: "write_file", Input: json.RawMessage(`{"path":"result.txt","content":"From the remote checkout"}`)}}},
		fake.Reply{Calls: []model.ToolCall{{ID: "question", Name: "ask_user", Input: json.RawMessage(`{"text":"Ready to report?"}`)}}},
		fake.Reply{Expect: func(request model.Request) error {
			body, _ := json.Marshal(request.Messages)
			if !strings.Contains(string(body), "Shared host instructions") {
				return errors.New("remote member did not receive the host shared document")
			}
			return nil
		}, Calls: []model.ToolCall{{ID: "report", Name: "submit_report", Input: json.RawMessage(`{"verdict":"done","summary":"From the other engine","artifacts":[],"checks":[]}`)}}},
	)
	deps5 := enginetest.Deps(t)
	deps5.Dial = cloudlink.Dial
	deps5.Workdir = t.TempDir()
	deps5.Providers = map[string]model.Provider{"fake": provider}
	b, err := engine.New(deps5)
	if err != nil {
		t.Fatal(err)
	}
	defer b.Close()
	p := definition.DefaultMerakCode()
	p.ID, p.Model.Provider = "source-profile", "fake"
	p.Mode = permission.ModeAsk
	if _, err := b.SaveAgent(ctx, "owner", p); err != nil {
		t.Fatal(err)
	}
	if _, err := b.CreateGroup(ctx, group.Group{ID: "source", Kind: group.KindLocal, Name: "Source", Leader: "leader", Project: group.Project{Directory: checkout}}, []group.Member{{ID: "leader", Kind: group.MemberAgent, Name: "Leader", AgentRole: group.AgentLeader, Agent: "builtin-merakcode"}, {ID: "worker", Kind: group.MemberAgent, Name: "Worker", AgentRole: group.AgentWorker, Agent: p.ID, Checkouts: map[string]string{remoteURL: checkout}}}); err != nil {
		t.Fatal(err)
	}
	first, err := server.Start(a, t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer first.Close()
	second, err := server.Start(b, t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer second.Close()
	client, err := protocol.Connect(ctx, first.Info.Endpoint, first.Info.Token, protocol.HelloParams{Protocol: protocol.Version})
	if err != nil {
		t.Fatal(err)
	}
	defer client.Close()
	var connection wire.RemoteConnection
	if err := client.Call(ctx, "remote.connect", wire.RemoteConnectParams{Endpoint: second.Info.Endpoint, Token: second.Info.Token}, &connection); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		_ = vault.New(filepath.Join(dataDir, "credentials")).Delete(context.Background(), "remote:"+string(connection.ID))
	})
	p = definition.DefaultMerakCode()
	p.ID = "remote-profile"
	p.Product = &definition.Product{Kind: definition.KindRemote, Remote: &definition.RemoteSource{Connection: connection.ID, Group: "source", Member: "worker", Caps: connection.Members[1].Caps}}
	if _, err := a.SaveAgent(ctx, "owner", p); err != nil {
		t.Fatal(err)
	}
	// The Leader receives the large history too; only the remote worker's transport is under test.
	a.ConfigureModels([]catalog.Override{{Provider: "leader", Window: new(8 * 1024 * 1024)}})
	lead := definition.DefaultMerakCode()
	lead.ID, lead.Model.Provider = "leader-profile", "leader"
	if _, err := a.SaveAgent(ctx, "owner", lead); err != nil {
		t.Fatal(err)
	}
	// Keep the history intact without waking the unrelated Leader for every replayed message.
	history := group.Trigger{ID: "history", When: event.Filter{Types: []event.Type{group.HumanSaid}}, Then: group.Action{Kind: group.WakeLeader}, Cooldown: time.Minute}
	if _, err := a.CreateGroup(ctx, group.Group{ID: "local-host", Kind: group.KindLocal, Name: "Host", Leader: "leader", Project: group.Project{Directory: t.TempDir(), Remote: remoteURL}, Settings: group.Settings{Triggers: []group.Trigger{history}}}, []group.Member{{ID: "leader", Kind: group.MemberAgent, Name: "Leader", AgentRole: group.AgentLeader, Agent: lead.ID}, {ID: "remote-member", Kind: group.MemberAgent, Name: "Remote", AgentRole: group.AgentWorker, Agent: p.ID, Remote: true, Checkouts: map[string]string{remoteURL: checkout}}, {ID: "owner", Name: "Owner", Kind: group.MemberHuman, Role: group.RoleOwner}, {ID: "approver", Name: "Approver", Kind: group.MemberHuman, Role: group.RoleApprover}}); err != nil {
		t.Fatal(err)
	}
	card, err := a.CreateTask(ctx, task.Card{Group: "local-host", Title: "Execute remotely", Workspace: "worktree", Base: base})
	if err != nil {
		t.Fatal(err)
	}
	if err := hostStore.Put(ctx, store.Doc{Kind: "shared", Key: "local-host/instructions", Body: []byte("Shared host instructions"), Meta: map[string]string{"group": "local-host"}}); err != nil {
		t.Fatal(err)
	}
	waitHistory := func(fact event.Event) {
		t.Helper()
		for {
			view, err := a.GroupState(ctx, card.Group)
			if err != nil {
				t.Fatal(err)
			}
			if view.LastSeq >= fact.Seq {
				return
			}
			select {
			case <-time.After(time.Millisecond):
			case <-ctx.Done():
				t.Fatal(ctx.Err())
			}
		}
	}
	for range 2 {
		body, _ := json.Marshal(map[string]string{"text": strings.Repeat("history", 450000)})
		fact, err := a.Publish(ctx, event.Event{Stream: "group:local-host", Scope: event.Scope{Group: "local-host"}, Type: group.HumanSaid, Payload: body})
		if err != nil {
			t.Fatal(err)
		}
		waitHistory(fact)
	}
	for i := range 1200 {
		fact, err := a.Publish(ctx, event.Event{Stream: "group:local-host", Scope: event.Scope{Group: "local-host"}, Type: group.HumanSaid, Payload: json.RawMessage(`{"text":"Earlier discussion"}`)})
		if err != nil {
			t.Fatal(err)
		}
		// Let the running group consume each batch before publishing more history.
		if (i+1)%128 == 0 || i == 1199 {
			waitHistory(fact)
		}
	}
	reports, stopReports := a.Subscribe(event.Filter{Scope: event.Scope{Group: card.Group, Task: card.ID}, Types: []event.Type{task.Reported}})
	defer stopReports()
	claim, err := a.AssignTask(ctx, card.ID, "owner", "remote-member", task.RoleOwner, nil)
	if err != nil {
		t.Fatal(err)
	}
	var report task.Report
	select {
	case fact := <-reports:
		var current task.Card
		current, err = event.Decode[task.Card](fact)
		if err == nil {
			found := false
			for _, reported := range current.Claims {
				if reported.ID == claim.ID && reported.Report != nil {
					claim, report, found = reported, *reported.Report, true
					break
				}
			}
			if !found {
				err = errors.New("remote claim has no report")
			}
		}
	case <-ctx.Done():
		err = ctx.Err()
	}
	if err != nil || report.Verdict != task.VerdictDone || report.Summary != "From the other engine" {
		t.Fatalf("report=%+v %v", report, err)
	}
	if approvals.Load() != 1 {
		t.Fatalf("host approvals=%d", approvals.Load())
	}
	if questions.Load() != 1 {
		t.Fatalf("host questions=%d", questions.Load())
	}
	facts, err := a.FindEvents(ctx, store.Query{Scope: event.Scope{Group: card.Group, Session: claim.Session}})
	if err != nil || len(facts) == 0 {
		t.Fatalf("events=%d %v", len(facts), err)
	}
	for _, fact := range facts {
		if fact.Type == permission.Replied {
			reply, err := event.Decode[permission.Reply](fact)
			if err != nil || reply.Decision != permission.Allow {
				t.Fatalf("remote workspace write rejected the host approver: %+v %v", reply, err)
			}
		}
		if fact.Stream == event.Stream("group:"+card.Group) {
			continue
		}
		original, err := b.GetEvent(ctx, fact.ID)
		if err != nil || original.Stream != fact.Stream || original.Seq != fact.Seq {
			t.Fatalf("remote event identity changed: %+v %v", fact, err)
		}
	}
}
