package server_test

import (
	"context"
	"encoding/json"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/TongTong313/merakcode/merak/engine"
	"github.com/TongTong313/merakcode/merak/engine/agent/definition"
	"github.com/TongTong313/merakcode/merak/engine/agent/model"
	"github.com/TongTong313/merakcode/merak/engine/agent/model/fake"
	"github.com/TongTong313/merakcode/merak/engine/agent/question"
	"github.com/TongTong313/merakcode/merak/engine/collab/group"
	"github.com/TongTong313/merakcode/merak/engine/collab/task"
	"github.com/TongTong313/merakcode/merak/engine/collab/wire"
	"github.com/TongTong313/merakcode/merak/engine/collab/worker"
	"github.com/TongTong313/merakcode/merak/engine/infra/event"
	"github.com/TongTong313/merakcode/merak/engine/infra/store"
	"github.com/TongTong313/merakcode/merak/protocol"
	"github.com/TongTong313/merakcode/merak/server"
	"github.com/TongTong313/merakcode/merak/testkit/enginetest"
)

func TestAWorkerQuestionReachesTheNamedHumanAndReturnsToItsClaim(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	dir := t.TempDir()
	var handler *server.Server
	leaderCalled := make(chan struct{}, 1)
	leaderModel := fake.New(t, fake.Reply{Text: "Unexpected wake", Expect: func(model.Request) error { leaderCalled <- struct{}{}; return nil }})
	provider := fake.New(t,
		fake.Reply{Calls: []model.ToolCall{{ID: "ask", Name: "ask_user", Input: json.RawMessage(`{"text":"Choose a color","to":"named"}`)}}},
		fake.Reply{Calls: []model.ToolCall{{ID: "report", Name: "submit_report", Input: json.RawMessage(`{"verdict":"done","summary":"Blue selected"}`)}}, Expect: func(req model.Request) error {
			body, _ := json.Marshal(req.Messages[len(req.Messages)-1])
			if !strings.Contains(string(body), "Blue") {
				t.Errorf("answer did not reach the worker: %s", body)
			}
			return nil
		}},
	)
	deps := enginetest.Deps(t)
	deps.Workdir = dir
	deps.Providers = map[string]model.Provider{"fake": provider, "leader-model": leaderModel}
	deps.AskQuestion = func(ctx context.Context, r question.Request) (question.Answer, error) {
		return handler.AskQuestion(ctx, r)
	}
	e, err := engine.New(deps)
	if err != nil {
		t.Fatal(err)
	}
	handler = server.New(e, "fixture-token")
	defer handler.Close()
	host := httptest.NewServer(handler)
	defer host.Close()
	client, err := protocol.Connect(ctx, "ws"+strings.TrimPrefix(host.URL, "http"), handler.AddIdentity("named"), protocol.HelloParams{Protocol: 1, Client: protocol.ClientInfo{Name: "test", Version: "1"}, Capabilities: protocol.Capabilities{Approve: true}})
	if err != nil {
		t.Fatal(err)
	}
	defer client.Close()
	lead := definition.DefaultMerakCode()
	lead.ID, lead.Model.Provider = "lead-profile", "leader-model"
	p := definition.DefaultMerakCode()
	p.ID, p.Model.Provider = "worker-profile", "fake"
	p.ToolPool = "worker.readonly"
	g, err := createGroup(t, e, ctx, group.Group{Kind: group.KindLocal, Name: "Group", Project: group.Project{Directory: dir}, Leader: "leader", Settings: group.Settings{Triggers: []group.Trigger{{ID: "choose", When: event.Filter{Types: []event.Type{"external.choose"}}, Then: group.Action{Kind: group.CreateTask, Template: "Choose"}}}}}, []group.Member{
		{ID: "leader", Name: "Leader", Kind: group.MemberAgent, AgentRole: group.AgentLeader, Agent: lead.ID},
		{ID: "worker", Name: "Worker", Kind: group.MemberAgent, AgentRole: group.AgentWorker, Agent: p.ID},
		{ID: "named", Name: "Named human", Kind: group.MemberHuman},
		{ID: "other", Name: "Other human", Kind: group.MemberHuman},
		{ID: "owner", Name: "Owner", Kind: group.MemberHuman, Role: group.RoleOwner},
	}, []definition.Agent{lead, p})
	if err != nil {
		t.Fatal(err)
	}
	created, stopCreated := e.Subscribe(event.Filter{Scope: event.Scope{Group: g.ID}, Types: []event.Type{task.Opened}})
	defer stopCreated()
	if _, err := e.EmitEvent(ctx, g.ID, "external.choose", json.RawMessage(`{}`)); err != nil {
		t.Fatal(err)
	}
	var card task.Card
	select {
	case fact := <-created:
		card, err = event.Decode[task.Card](fact)
	case <-ctx.Done():
		t.Fatal(ctx.Err())
	}
	if err != nil {
		t.Fatal(err)
	}
	run, err := e.StartWorker(ctx, p, worker.Assignment{Session: event.NewID(), Workdir: dir, Scope: event.Scope{Group: g.ID, Task: card.ID}, Packet: "Ask", Claim: task.Claim{ID: "claim", Task: card.ID, Member: "worker"}})
	if err != nil {
		t.Fatal(err)
	}
	for {
		select {
		case fact := <-client.Events:
			if fact.Type != question.Asked {
				continue
			}
			params := wire.QuestionReplyParams{Request: fact.ID, Text: "Blue"}
			if _, err := e.AuthorizeQuestion(ctx, fact.ID, "other"); err == nil {
				t.Fatal("another ordinary member may answer the question")
			}
			if err := client.Call(ctx, "question.reply", params, nil); err != nil {
				t.Fatal(err)
			}
			report, err := run.Wait(ctx)
			if err != nil || report.Summary != "Blue selected" {
				t.Fatalf("report=%+v err=%v", report, err)
			}
			facts, err := e.FindEvents(ctx, store.Query{Scope: event.Scope{Group: g.ID}, Types: []event.Type{group.NoticeSent}})
			if err != nil {
				t.Fatal(err)
			}
			found := false
			for _, noticeFact := range facts {
				notice, _ := event.Decode[group.Notice](noticeFact)
				if notice.Kind == "question" && noticeFact.Cause == fact.ID && len(notice.To) == 1 && notice.To[0] == "named" {
					found = true
				}
			}
			if !found {
				t.Fatal("named human did not receive an inbox notice")
			}
			select {
			case <-leaderCalled:
				t.Fatal("a direct human answer woke the Leader")
			case <-time.After(2 * time.Second):
			}
			return
		case <-ctx.Done():
			t.Fatal(ctx.Err())
		}
	}
}
