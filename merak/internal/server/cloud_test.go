package server_test

import (
	"bytes"
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/TongTong313/merakcode/merak/engine"
	"github.com/TongTong313/merakcode/merak/engine/event"
	"github.com/TongTong313/merakcode/merak/engine/group"
	"github.com/TongTong313/merakcode/merak/engine/question"
	"github.com/TongTong313/merakcode/merak/engine/session"
	"github.com/TongTong313/merakcode/merak/engine/store"
	"github.com/TongTong313/merakcode/merak/engine/task"
	"github.com/TongTong313/merakcode/merak/internal/cloud"
	"github.com/TongTong313/merakcode/merak/internal/server"
	"github.com/TongTong313/merakcode/merak/internal/testcloud"
	"github.com/TongTong313/merakcode/merak/protocol"
)

func TestCloudHistoryEstablishesRoutingForTasksAndSessions(t *testing.T) {
	ctx, cancel := context.WithTimeout(t.Context(), 5*time.Second)
	defer cancel()
	groupBody, _ := json.Marshal(group.State{Group: group.Group{ID: "history", Kind: group.KindCloud}})
	card := task.Card{ID: "historic-task", Group: "history", Title: "Existing task", Status: task.Review}
	taskBody, _ := json.Marshal(card)
	facts := []event.Event{
		{ID: "history-created", Type: group.Created, Stream: "group:history", Scope: event.Scope{Group: "history"}, Seq: 1, Time: time.Now(), Payload: groupBody},
		{ID: "history-task", Type: task.Created, Stream: "group:history", Scope: event.Scope{Group: "history", Task: card.ID, Session: "historic-session"}, Seq: 2, Time: time.Now(), Payload: taskBody},
	}
	peer := testcloud.New(t)
	peer.Handle = func(request protocol.Message) (any, error) {
		switch request.Method {
		case "events.find":
			return facts[:1], nil
		case "events.read":
			return facts, nil
		case "task.review":
			return card, nil
		case "session.snapshot":
			return session.State{ID: "historic-session", Scope: event.Scope{Group: "history"}}, nil
		}
		t.Errorf("unexpected method %s", request.Method)
		return nil, nil
	}
	e, err := engine.New(engine.Deps{Workdir: t.TempDir()})
	if err != nil {
		t.Fatal(err)
	}
	defer e.Close()
	if err := e.ConnectCloud(ctx, peer.Credentials()); err != nil {
		t.Fatal(err)
	}
	if _, err := e.FindEvents(ctx, store.Query{Types: []event.Type{group.Created}}); err != nil {
		t.Fatal(err)
	}
	for _, request := range []struct{ method, params string }{
		{"events.read", `{"stream":"group:history","from":1}`},
		{"task.review", `{"task":"historic-task","decision":"approve"}`},
		{"session.snapshot", `{"session":"historic-session"}`},
	} {
		if _, forwarded, err := e.ForwardCloud(ctx, request.method, json.RawMessage(request.params)); err != nil || !forwarded {
			t.Fatalf("%s was not routed to its host: forwarded=%v %v", request.method, forwarded, err)
		}
	}
}

func TestCloudNoticeCanOpenARequestNotYetCachedOnThisDevice(t *testing.T) {
	ctx, cancel := context.WithTimeout(t.Context(), 5*time.Second)
	defer cancel()
	peer := testcloud.New(t)
	groupBody, _ := json.Marshal(group.State{Group: group.Group{ID: "notice-group", Kind: group.KindCloud}})
	created := event.Event{ID: "notice-created", Type: group.Created, Stream: "group:notice-group", Scope: event.Scope{Group: "notice-group"}, Seq: 1, Time: time.Now(), Payload: groupBody}
	body, _ := json.Marshal(question.Request{ID: "remote-question", Text: "Choose a result"})
	request := event.Event{ID: "remote-question", Type: question.Asked, Stream: "session:remote-question-session", Scope: event.Scope{Group: "notice-group", Session: "remote-question-session"}, Seq: 1, Time: time.Now(), Payload: body}
	peer.Handle = func(message protocol.Message) (any, error) {
		if message.Method == "events.find" {
			return []event.Event{created}, nil
		}
		if message.Method == "events.get" {
			return request, nil
		}
		t.Errorf("unexpected method %s", message.Method)
		return nil, nil
	}
	e, err := engine.New(engine.Deps{Workdir: t.TempDir()})
	if err != nil {
		t.Fatal(err)
	}
	defer e.Close()
	if err := e.ConnectCloud(ctx, peer.Credentials()); err != nil {
		t.Fatal(err)
	}
	if _, err := e.FindEvents(ctx, store.Query{Types: []event.Type{group.Created}}); err != nil {
		t.Fatal(err)
	}
	notices, stop := e.Bus.Subscribe(event.Filter{Types: []event.Type{group.NoticeSent}})
	defer stop()
	if err := peer.Send(ctx, protocol.CloudInbound{Cause: request.ID, Scope: event.Scope{Group: "notice-group"}, Notice: &group.Notice{Kind: "question", To: []event.ID{"human"}, Text: "Choose"}}); err != nil {
		t.Fatal(err)
	}
	select {
	case <-notices:
	case <-ctx.Done():
		t.Fatal(ctx.Err())
	}
	result, forwarded, err := e.ForwardCloud(ctx, "events.get", json.RawMessage(`{"id":"remote-question"}`))
	if err != nil || !forwarded {
		t.Fatalf("notice request was not routed: %s %v %v", result, forwarded, err)
	}
	if _, err := e.GetEvent(ctx, request.ID); err != nil {
		t.Fatal(err)
	}
}

func TestCloudGroupRPCIsForwardedWithoutLocalInterpretation(t *testing.T) {
	ctx, cancel := context.WithTimeout(t.Context(), 10*time.Second)
	defer cancel()
	peer := testcloud.New(t)
	peer.Handle = func(request protocol.Message) (any, error) {
		if request.Method == "group.create" {
			return group.Group{ID: "cloud-group", Kind: group.KindCloud, Name: "Cloud"}, nil
		}
		return json.RawMessage(`"cloud-message"`), nil
	}
	e, err := engine.New(engine.Deps{Workdir: t.TempDir(), Cloud: cloud.NewWebSocket()})
	if err != nil {
		t.Fatal(err)
	}
	defer e.Close()
	if err = e.ConnectCloud(ctx, peer.Credentials()); err != nil {
		t.Fatal(err)
	}
	host, err := server.Start(e, t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer host.Close()
	client, err := protocol.Connect(ctx, host.Info.Endpoint, host.Info.Token, protocol.HelloParams{Protocol: protocol.Version})
	if err != nil {
		t.Fatal(err)
	}
	defer client.Close()
	for _, request := range []struct {
		method string
		params json.RawMessage
	}{
		{"group.create", json.RawMessage(`{"kind":"cloud","name":"Cloud","cloudOnly":{"preserve":true}}`)},
		{"group.say", json.RawMessage(`{"group":"cloud-group","human":"cloud-human","message":{"text":"hello"},"cloudOnly":true}`)},
	} {
		var result json.RawMessage
		if err = client.Call(ctx, request.method, request.params, &result); err != nil {
			t.Fatal(err)
		}
		select {
		case got := <-peer.Requests:
			if got.Method != request.method || string(got.Params) != string(request.params) {
				t.Fatalf("forwarded=%s %s", got.Method, got.Params)
			}
		case <-ctx.Done():
			t.Fatal(ctx.Err())
		}
	}
}

func TestDevelopmentCloudLoginKeepsTokensOutOfClientResponses(t *testing.T) {
	ctx, cancel := context.WithTimeout(t.Context(), 10*time.Second)
	defer cancel()
	peer := testcloud.New(t)
	home := t.TempDir()
	e, err := engine.New(engine.Deps{DataDir: home, Workdir: t.TempDir()})
	if err != nil {
		t.Fatal(err)
	}
	defer e.Close()
	host, err := server.Start(e, home)
	if err != nil {
		t.Fatal(err)
	}
	defer host.Close()
	client, err := protocol.Connect(ctx, host.Info.Endpoint, host.Info.Token, protocol.HelloParams{Protocol: protocol.Version})
	if err != nil {
		t.Fatal(err)
	}
	defer client.Close()
	var status protocol.CloudStatus
	if err = client.Call(ctx, "cloud.login", protocol.CloudLoginParams{Dev: true, Endpoint: peer.Credentials().Endpoint}, &status); err != nil {
		t.Fatal(err)
	}
	if status.Account != "fixture-account" || !status.Online || status.Device == "" {
		t.Fatalf("status=%+v", status)
	}
	for _, method := range []string{"cloud.status", "config.get"} {
		var body json.RawMessage
		if err = client.Call(ctx, method, struct{}{}, &body); err != nil {
			t.Fatal(err)
		}
		if bytes.Contains(body, []byte("fixture-secret")) {
			t.Fatalf("%s exposed credentials", method)
		}
	}
	if err = client.Call(ctx, "cloud.logout", struct{}{}, nil); err != nil {
		t.Fatal(err)
	}
	status = protocol.CloudStatus{}
	if err = client.Call(ctx, "cloud.status", struct{}{}, &status); err != nil || status.Account != "" || status.Online {
		t.Fatalf("logout=%+v %v", status, err)
	}
	files, err := os.ReadDir(filepath.Join(home, "credentials"))
	if err != nil || len(files) != 0 {
		t.Fatalf("credential files=%d %v", len(files), err)
	}
}

func TestCloudMemberDirectoryReturnsOtherDevicesThroughTheProtocol(t *testing.T) {
	ctx, cancel := context.WithTimeout(t.Context(), 10*time.Second)
	defer cancel()
	peer := testcloud.New(t)
	peer.Handle = func(request protocol.Message) (any, error) {
		if request.Method != "cloud.members" {
			t.Errorf("unexpected cloud method %s", request.Method)
		}
		return []group.Member{
			{ID: "worker", Group: "source-a", Device: "device-a", Name: "First worker", Kind: group.MemberAgent, AgentRole: group.AgentWorker},
			{ID: "worker", Group: "source-b", Device: "device-b", Name: "Second worker", Kind: group.MemberAgent, AgentRole: group.AgentWorker},
		}, nil
	}
	e, err := engine.New(engine.Deps{Workdir: t.TempDir()})
	if err != nil {
		t.Fatal(err)
	}
	defer e.Close()
	if err = e.ConnectCloud(ctx, peer.Credentials()); err != nil {
		t.Fatal(err)
	}
	host, err := server.Start(e, t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer host.Close()
	client, err := protocol.Connect(ctx, host.Info.Endpoint, host.Info.Token, protocol.HelloParams{Protocol: protocol.Version})
	if err != nil {
		t.Fatal(err)
	}
	defer client.Close()
	var members []group.Member
	if err = client.Call(ctx, "cloud.members", struct{}{}, &members); err != nil {
		t.Fatal(err)
	}
	if len(members) != 2 || members[0].Device != "device-a" || members[1].Device != "device-b" || members[1].Group != "source-b" {
		t.Fatalf("directory did not preserve device identities: %+v", members)
	}
	if err = e.DisconnectCloud(ctx); err != nil {
		t.Fatal(err)
	}
	if err = client.Call(ctx, "cloud.members", struct{}{}, &members); err == nil {
		t.Fatal("signed-out directory request succeeded")
	}
}

func TestCloudLoginSaveFailureKeepsThePreviousConnection(t *testing.T) {
	ctx, cancel := context.WithTimeout(t.Context(), 10*time.Second)
	defer cancel()
	peer := testcloud.New(t)
	replacement := testcloud.New(t)
	home := t.TempDir()
	e, err := engine.New(engine.Deps{DataDir: home, Workdir: t.TempDir()})
	if err != nil {
		t.Fatal(err)
	}
	defer e.Close()
	host, err := server.Start(e, home)
	if err != nil {
		t.Fatal(err)
	}
	defer host.Close()
	client, err := protocol.Connect(ctx, host.Info.Endpoint, host.Info.Token, protocol.HelloParams{Protocol: protocol.Version})
	if err != nil {
		t.Fatal(err)
	}
	defer client.Close()
	var previous protocol.CloudStatus
	if err = client.Call(ctx, "cloud.login", protocol.CloudLoginParams{Dev: true, Endpoint: peer.Credentials().Endpoint}, &previous); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(home, "credentials")
	backup := filepath.Join(home, "saved-credentials")
	if err = os.Rename(path, backup); err != nil {
		t.Fatal(err)
	}
	defer func() {
		_ = os.Remove(path)
		_ = os.Rename(backup, path)
		_ = client.Call(context.Background(), "cloud.logout", struct{}{}, nil)
	}()
	if err = os.WriteFile(path, []byte("blocks the credential directory"), 0600); err != nil {
		t.Fatal(err)
	}
	if err = client.Call(ctx, "cloud.login", protocol.CloudLoginParams{Dev: true, Endpoint: replacement.Credentials().Endpoint}, nil); err == nil {
		t.Fatal("login succeeded without saving credentials")
	}
	var status protocol.CloudStatus
	if err = client.Call(ctx, "cloud.status", struct{}{}, &status); err != nil {
		t.Fatal(err)
	}
	if !status.Online || status.Account != previous.Account || status.Endpoint != previous.Endpoint || status.Device != previous.Device {
		t.Fatalf("failed login changed the connection: %+v", status)
	}
}
