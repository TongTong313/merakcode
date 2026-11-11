package server_test

import (
	"encoding/json"
	"path/filepath"
	"testing"
	"time"

	"github.com/TongTong313/merakcode/merak/engine"
	"github.com/TongTong313/merakcode/merak/engine/agent"
	"github.com/TongTong313/merakcode/merak/engine/event"
	"github.com/TongTong313/merakcode/merak/engine/group"
	"github.com/TongTong313/merakcode/merak/engine/model"
	"github.com/TongTong313/merakcode/merak/engine/model/fake"
	"github.com/TongTong313/merakcode/merak/engine/store"
	"github.com/TongTong313/merakcode/merak/engine/task"
	"github.com/TongTong313/merakcode/merak/internal/localstore"
	"github.com/TongTong313/merakcode/merak/internal/server"
	"github.com/TongTong313/merakcode/merak/protocol"
)

// A client that starts work and goes away does not stop it: the engine finishes the task and writes what happened to
// its own store.
func TestATaskKeepsRunningAfterTheClientDisconnects(t *testing.T) {
	ctx := t.Context()
	dir := t.TempDir()
	disk, err := localstore.Open(filepath.Join(t.TempDir(), "merak.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer disk.Close()
	release := make(chan struct{})
	report, _ := json.Marshal(map[string]string{"verdict": "done", "summary": "Finished while nobody watched"})
	worker := fake.New(t, fake.Reply{Hold: release, Calls: []model.ToolCall{{ID: "report", Name: "submit_report", Input: report}}})
	e, err := engine.New(engine.Deps{Workdir: dir, Store: disk, Providers: map[string]model.Provider{"worker": worker, "leader": fake.New(t, repeat(12, fake.Reply{Text: "Waiting."})...)}})
	if err != nil {
		t.Fatal(err)
	}
	defer e.Close()
	instance, err := server.Start(e, t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer instance.Close()
	client, err := protocol.Connect(ctx, instance.Info.Endpoint, instance.Info.Token, protocol.HelloParams{Protocol: protocol.Version})
	if err != nil {
		t.Fatal(err)
	}
	lead, work := agent.DefaultLeader(), agent.DefaultWorker()
	lead.ID, lead.Model.Provider, work.ID, work.Model.Provider = "lead", "leader", "work", "worker"
	for _, a := range []agent.Agent{lead, work} {
		if err := client.Call(ctx, "agent.save", protocol.AgentSaveParams{Agent: a}, nil); err != nil {
			t.Fatal(err)
		}
	}
	var g group.Group
	if err := client.Call(ctx, "group.create", protocol.GroupCreateParams{Group: group.Group{Kind: group.KindLocal, Name: "Daemon", Project: group.Project{Directory: dir}, Leader: "leader"}, Members: []group.Member{
		{ID: protocol.LocalHuman, Name: "Owner", Kind: group.MemberHuman, Role: group.RoleOwner},
		{ID: "leader", Name: "Leader", Kind: group.MemberAgent, AgentRole: group.AgentLeader, Agent: lead.ID},
		{ID: "worker", Name: "Worker", Kind: group.MemberAgent, AgentRole: group.AgentWorker, Agent: work.ID},
	}}, &g); err != nil {
		t.Fatal(err)
	}
	var card task.Card
	if err := client.Call(ctx, "task.create", protocol.TaskCreateParams{Group: g.ID, Member: "worker", Title: "Work alone", Workspace: "none"}, &card); err != nil {
		t.Fatal(err)
	}
	client.Close()
	close(release)
	deadline := time.After(10 * time.Second)
	for {
		facts, err := disk.Find(ctx, store.Query{Scope: event.Scope{Task: card.ID}, Types: []event.Type{task.Reported}})
		if err != nil {
			t.Fatal(err)
		}
		if len(facts) > 0 {
			return
		}
		select {
		case <-deadline:
			t.Fatal("the task did not report after the client left")
		case <-time.After(25 * time.Millisecond):
		}
	}
}

func repeat(count int, reply fake.Reply) []fake.Reply {
	replies := make([]fake.Reply, count)
	for i := range replies {
		replies[i] = reply
	}
	return replies
}
