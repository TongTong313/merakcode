package server_test

import (
	"context"
	"encoding/json"
	"github.com/TongTong313/merakcode/merak/engine"
	"github.com/TongTong313/merakcode/merak/engine/event"
	"github.com/TongTong313/merakcode/merak/engine/group"
	"github.com/TongTong313/merakcode/merak/engine/model"
	"github.com/TongTong313/merakcode/merak/engine/model/fake"
	"github.com/TongTong313/merakcode/merak/engine/profile"
	"github.com/TongTong313/merakcode/merak/engine/question"
	"github.com/TongTong313/merakcode/merak/engine/store"
	"github.com/TongTong313/merakcode/merak/engine/task"
	"github.com/TongTong313/merakcode/merak/engine/worker"
	"github.com/TongTong313/merakcode/merak/internal/server"
	"github.com/TongTong313/merakcode/merak/protocol"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
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
	e, err := engine.New(engine.Deps{Workdir: dir, Providers: map[string]model.Provider{"fake": provider, "leader-model": leaderModel}, AskQuestion: func(ctx context.Context, r question.Request) (question.Answer, error) {
		return handler.AskQuestion(ctx, r)
	}})
	if err != nil {
		t.Fatal(err)
	}
	handler = server.New(e, "fixture-token")
	defer handler.Close()
	host := httptest.NewServer(handler)
	defer host.Close()
	client, err := protocol.Connect(ctx, "ws"+strings.TrimPrefix(host.URL, "http"), "fixture-token", protocol.HelloParams{Protocol: 1, Client: protocol.ClientInfo{Name: "test", Version: "1"}, Capabilities: protocol.Capabilities{Approve: true}})
	if err != nil {
		t.Fatal(err)
	}
	defer client.Close()
	lead := profile.DefaultLeader()
	lead.ID, lead.Model.Provider = "lead-profile", "leader-model"
	p := profile.DefaultWorker()
	p.ID, p.Model.Provider = "worker-profile", "fake"
	p.ToolPool = "worker.readonly"
	g, err := e.CreateGroup(ctx, group.Group{Kind: group.KindLocal, Name: "Group", Project: group.Project{Directory: dir}, DefaultLeader: "leader"}, []group.Member{
		{ID: "leader", Name: "Leader", Kind: group.MemberAgent, AgentRole: group.AgentLeader, Profile: lead.ID},
		{ID: "worker", Name: "Worker", Kind: group.MemberAgent, AgentRole: group.AgentWorker, Profile: p.ID},
		{ID: "named", Name: "Named human", Kind: group.MemberHuman},
		{ID: "other", Name: "Other human", Kind: group.MemberHuman},
		{ID: "owner", Name: "Owner", Kind: group.MemberHuman, Role: group.RoleOwner},
	}, []profile.Profile{lead, p})
	if err != nil {
		t.Fatal(err)
	}
	card, err := e.Tasks.Create(ctx, task.Card{Group: g.ID, Title: "Choose"})
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
			params := protocol.QuestionReplyParams{Request: fact.ID, Text: "Blue", Human: "other"}
			if err := client.Call(ctx, "question.reply", params, nil); err == nil {
				t.Fatal("another ordinary member answered the question")
			}
			params.Human = "named"
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
