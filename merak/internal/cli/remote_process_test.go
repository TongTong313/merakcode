package cli

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"runtime"
	"testing"
	"time"

	"github.com/TongTong313/merakcode/merak/engine/event"
	"github.com/TongTong313/merakcode/merak/engine/group"
	"github.com/TongTong313/merakcode/merak/engine/model"
	"github.com/TongTong313/merakcode/merak/engine/model/fake"
	"github.com/TongTong313/merakcode/merak/engine/permission"
	"github.com/TongTong313/merakcode/merak/engine/profile"
	"github.com/TongTong313/merakcode/merak/engine/question"
	"github.com/TongTong313/merakcode/merak/engine/task"
	"github.com/TongTong313/merakcode/merak/engine/worker"
	"github.com/TongTong313/merakcode/merak/internal/platform/credential"
	"github.com/TongTong313/merakcode/merak/internal/platform/process"
	"github.com/TongTong313/merakcode/merak/internal/server"
	"github.com/TongTong313/merakcode/merak/protocol"
)

func TestRemoteServeReportsAndDisconnectsThroughTheSDK(t *testing.T) {
	ctx, cancel := context.WithTimeout(t.Context(), 45*time.Second)
	defer cancel()
	binary := filepath.Join(t.TempDir(), "merak")
	if runtime.GOOS == "windows" {
		binary += ".exe"
	}
	if output, err := process.Command(ctx, "../..", "go", "build", "-o", binary, "./cmd/merak").CombinedOutput(); err != nil {
		t.Fatalf("build: %s %v", output, err)
	}
	type peer struct {
		client *protocol.Client
		info   protocol.ConnectionInfo
		home   string
		stop   func()
	}
	start := func(replies []fake.Reply) peer {
		t.Helper()
		home := t.TempDir()
		body, err := json.Marshal(replies)
		if err != nil {
			t.Fatal(err)
		}
		script := filepath.Join(home, "replies.json")
		if err := os.WriteFile(script, body, 0600); err != nil {
			t.Fatal(err)
		}
		command := process.Command(ctx, home, binary, "serve", "--script", script)
		command.Env = append(os.Environ(), "MERAKCODE_HOME="+home)
		if err := command.Start(); err != nil {
			t.Fatal(err)
		}
		exited := make(chan struct{})
		go func() { _ = command.Wait(); close(exited) }()
		stop := func() { _ = command.Process.Kill(); <-exited }
		t.Cleanup(stop)
		for {
			info, err := server.ReadInfo(home)
			if err == nil {
				client, err := protocol.Connect(ctx, info.Endpoint, info.Token, protocol.HelloParams{Protocol: protocol.Version})
				if err != nil {
					t.Fatal(err)
				}
				t.Cleanup(func() { _ = client.Close() })
				return peer{client: client, info: info, home: home, stop: stop}
			}
			select {
			case <-exited:
				t.Fatal("serve exited before publishing its endpoint")
			case <-ctx.Done():
				t.Fatal(ctx.Err())
			case <-time.After(20 * time.Millisecond):
			}
		}
	}
	waiting := make([]fake.Reply, 32)
	for i := range waiting {
		waiting[i].Text = "Waiting for the worker."
	}
	a := start(waiting)
	b := start([]fake.Reply{
		{Calls: []model.ToolCall{{ID: "report", Name: "submit_report", Input: json.RawMessage(`{"verdict":"done","summary":"Remote task completed"}`)}}},
		{Calls: []model.ToolCall{{ID: "question", Name: "ask_user", Input: json.RawMessage(`{"text":"Remote worker is waiting"}`)}}},
	})
	checkout := t.TempDir()
	const remoteURL = "https://example.test/repository.git"
	for _, args := range [][]string{{"init", checkout}, {"-C", checkout, "remote", "add", "origin", remoteURL}} {
		if output, err := process.Command(ctx, checkout, "git", args...).CombinedOutput(); err != nil {
			t.Fatalf("git %v: %s %v", args, output, err)
		}
	}
	create := func(client *protocol.Client, id event.ID, work profile.Profile, checkouts map[string]string) {
		t.Helper()
		lead := profile.DefaultLeader()
		lead.ID, lead.Model.Provider = "lead-profile", "fake"
		params := protocol.GroupCreateParams{
			Group: group.Group{ID: id, Name: string(id), Kind: group.KindLocal, DefaultLeader: "leader", Project: group.Project{Directory: t.TempDir()}},
			Members: []group.Member{
				{ID: "owner", Kind: group.MemberHuman, Name: "Owner", Role: group.RoleOwner},
				{ID: "leader", Kind: group.MemberAgent, Name: "Leader", AgentRole: group.AgentLeader, Profile: lead.ID},
				{ID: "worker", Kind: group.MemberAgent, Name: "Worker", AgentRole: group.AgentWorker, Profile: work.ID, Checkouts: checkouts},
			}, Profiles: []profile.Profile{lead, work},
		}
		if err := client.Call(ctx, "group.create", params, nil); err != nil {
			t.Fatal(err)
		}
	}
	work := profile.DefaultWorker()
	work.ID, work.Model.Provider, work.Mode = "work-profile", "fake", permission.ModeTakeover
	create(b.client, "source", work, map[string]string{remoteURL: checkout})
	var connection protocol.RemoteConnection
	if err := a.client.Call(ctx, "remote.connect", protocol.RemoteConnectParams{Endpoint: b.info.Endpoint, Token: b.info.Token}, &connection); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		_ = credential.New(filepath.Join(a.home, "credentials")).Delete(context.Background(), "remote:"+string(connection.ID))
	})
	var source *protocol.RemoteMember
	for i := range connection.Members {
		if connection.Members[i].Member.ID == "worker" {
			source = &connection.Members[i]
		}
	}
	if source == nil {
		t.Fatal("the other process's registered member was not discovered")
	}
	declared, err := os.Stat(source.Member.Checkouts[remoteURL])
	if err != nil {
		t.Fatal(err)
	}
	expected, err := os.Stat(checkout)
	if err != nil || !os.SameFile(declared, expected) {
		t.Fatalf("remote checkout changed: %v", err)
	}
	work.Product = &profile.Product{Kind: worker.KindRemote, Remote: &profile.RemoteSource{Connection: connection.ID, Group: "source", Member: "worker", Caps: source.Caps}}
	create(a.client, "host", work, nil)
	if err := a.client.Call(ctx, "events.subscribe", event.Filter{Scope: event.Scope{Group: "host"}}, nil); err != nil {
		t.Fatal(err)
	}
	var card task.Card
	if err := a.client.Call(ctx, "task.create", protocol.TaskCreateParams{Group: "host", Human: "owner", Title: "Report remotely", Workspace: "none", Member: "worker"}, &card); err != nil {
		t.Fatal(err)
	}
	waitFor := func(kind event.Type) event.Event {
		t.Helper()
		for {
			select {
			case fact, ok := <-a.client.Events:
				if !ok {
					t.Fatal("host connection closed")
				}
				if fact.Scope.Task == card.ID && fact.Type == kind {
					return fact
				}
			case <-ctx.Done():
				t.Fatal(ctx.Err())
			}
		}
	}
	reported, err := event.Decode[task.Card](waitFor(task.Reported))
	if err != nil || len(reported.Claims) != 1 || reported.Claims[0].Report == nil {
		t.Fatalf("missing remote report: %+v %v", reported, err)
	}
	if report := reported.Claims[0].Report; report.Verdict != task.VerdictDone || report.Summary != "Remote task completed" || report.Synthesized {
		t.Fatalf("remote report changed: %+v", report)
	}
	if err := a.client.Call(ctx, "task.create", protocol.TaskCreateParams{Group: "host", Human: "owner", Title: "Ask remotely", Workspace: "none", Member: "worker"}, &card); err != nil {
		t.Fatal(err)
	}
	forwarded := waitFor(question.Asked)
	var original event.Event
	if err := b.client.Call(ctx, "events.get", protocol.EventsGetParams{ID: forwarded.ID}, &original); err != nil {
		t.Fatal(err)
	}
	if original.Stream != forwarded.Stream || original.Seq != forwarded.Seq {
		t.Fatal("remote event identity changed")
	}
	b.stop()
	for {
		fact := waitFor(task.Updated)
		updated, err := event.Decode[task.Card](fact)
		if err != nil {
			t.Fatal(err)
		}
		if updated.Status == task.Blocked && len(updated.Claims) == 1 && updated.Claims[0].Status == task.ClaimInterrupted {
			return
		}
	}
}
