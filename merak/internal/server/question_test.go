package server_test

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/TongTong313/merakcode/merak/engine"
	"github.com/TongTong313/merakcode/merak/engine/event"
	"github.com/TongTong313/merakcode/merak/engine/loop"
	"github.com/TongTong313/merakcode/merak/engine/model"
	"github.com/TongTong313/merakcode/merak/engine/model/fake"
	"github.com/TongTong313/merakcode/merak/engine/question"
	"github.com/TongTong313/merakcode/merak/internal/server"
	"github.com/TongTong313/merakcode/merak/protocol"
)

func TestQuestionReplyContinuesTheModelAndRejectsAnotherConnection(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	var handler *server.Server
	e, err := engine.New(engine.Deps{Workdir: t.TempDir(), AskQuestion: func(ctx context.Context, request question.Request) (question.Answer, error) {
		return handler.AskQuestion(ctx, request)
	}, Providers: map[string]model.Provider{"fake": fake.New(t,
		fake.Reply{Calls: []model.ToolCall{{ID: "question-call", Name: "ask_user", Input: json.RawMessage(`{"text":"Choose a color","options":["Blue","Green"]}`)}}},
		fake.Reply{Text: "Blue selected", Expect: func(req model.Request) error {
			last := req.Messages[len(req.Messages)-1]
			if last.Role != model.Tool || last.Parts[0].ToolResult == nil || last.Parts[0].ToolResult.IsError || last.Parts[0].ToolResult.Parts[0].Text != "Blue" {
				return fmt.Errorf("answer not delivered: %+v", last)
			}
			return nil
		}},
	)}})
	if err != nil {
		t.Fatal(err)
	}
	handler = server.New(e, "token")
	defer handler.Close()
	httpServer := httptest.NewServer(handler)
	defer httpServer.Close()
	connect := func(approve bool) *protocol.Client {
		client, err := protocol.Connect(ctx, "ws"+strings.TrimPrefix(httpServer.URL, "http"), "token", protocol.HelloParams{Protocol: 1, Client: protocol.ClientInfo{Name: "test", Version: "1"}, Capabilities: protocol.Capabilities{Approve: approve}})
		if err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() { client.Close() })
		return client
	}
	owner, other := connect(true), connect(false)
	var created protocol.SessionCreateResult
	if err := owner.Call(ctx, "session.create", protocol.SessionCreateParams{Provider: "fake"}, &created); err != nil {
		t.Fatal(err)
	}
	if err := owner.Call(ctx, "events.subscribe", event.Filter{Scope: event.Scope{Session: created.Session}}, nil); err != nil {
		t.Fatal(err)
	}
	if err := owner.Call(ctx, "session.send", protocol.SessionSendParams{Session: created.Session, Parts: []model.Part{{Text: "Ask me"}}}, nil); err != nil {
		t.Fatal(err)
	}
	answered := false
	for {
		select {
		case fact := <-owner.Events:
			if fact.Type == question.Asked {
				params := protocol.QuestionReplyParams{Request: fact.ID, Text: "Blue"}
				if err := other.Call(ctx, "question.reply", params, nil); err == nil {
					t.Fatal("non-owner answered")
				}
				if err := owner.Call(ctx, "question.reply", params, nil); err != nil {
					t.Fatal(err)
				}
			}
			if fact.Type == question.Answered {
				answered = true
			}
			if fact.Type == "turn.finished" {
				if !answered {
					t.Fatal("question was never answered")
				}
				return
			}
		case <-ctx.Done():
			t.Fatal(ctx.Err())
		}
	}
}

func TestUnansweredQuestionFinishesOnSkipCancellationOrDisconnect(t *testing.T) {
	for _, action := range []string{"skip", "cancel", "disconnect", "no owner"} {
		t.Run(action, func(t *testing.T) {
			ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
			defer cancel()
			var handler *server.Server
			e, err := engine.New(engine.Deps{Workdir: t.TempDir(), AskQuestion: func(ctx context.Context, request question.Request) (question.Answer, error) {
				return handler.AskQuestion(ctx, request)
			}, Providers: map[string]model.Provider{"fake": fake.New(t,
				fake.Reply{Calls: []model.ToolCall{{ID: "question", Name: "ask_user", Input: json.RawMessage(`{"text":"Choose"}`)}}},
				fake.Reply{Text: "Continued", Expect: func(req model.Request) error {
					last := req.Messages[len(req.Messages)-1]
					if last.Role != model.Tool || last.Parts[0].ToolResult == nil || !last.Parts[0].ToolResult.IsError {
						return fmt.Errorf("unanswered question was treated as an answer")
					}
					return nil
				}},
			)}})
			if err != nil {
				t.Fatal(err)
			}
			handler = server.New(e, "token")
			defer handler.Close()
			host := httptest.NewServer(handler)
			defer host.Close()
			owner, err := protocol.Connect(ctx, "ws"+strings.TrimPrefix(host.URL, "http"), "token", protocol.HelloParams{Protocol: 1, Client: protocol.ClientInfo{Name: "test", Version: "1"}, Capabilities: protocol.Capabilities{Approve: action != "no owner"}})
			if err != nil {
				t.Fatal(err)
			}
			defer owner.Close()
			var created protocol.SessionCreateResult
			if err := owner.Call(ctx, "session.create", protocol.SessionCreateParams{Provider: "fake"}, &created); err != nil {
				t.Fatal(err)
			}
			facts, stop := e.Bus.Subscribe(event.Filter{Scope: event.Scope{Session: created.Session}, Types: []event.Type{question.Answered, loop.TurnFinished}})
			defer stop()
			if err := owner.Call(ctx, "events.subscribe", event.Filter{Scope: event.Scope{Session: created.Session}}, nil); err != nil {
				t.Fatal(err)
			}
			if err := owner.Call(ctx, "session.send", protocol.SessionSendParams{Session: created.Session, Parts: []model.Part{{Text: "Ask"}}}, nil); err != nil {
				t.Fatal(err)
			}
			if action != "no owner" {
				for {
					select {
					case fact := <-owner.Events:
						if fact.Type != question.Asked {
							continue
						}
						switch action {
						case "skip":
							if err := owner.Call(ctx, "question.reply", protocol.QuestionReplyParams{Request: fact.ID, Cancelled: true}, nil); err != nil {
								t.Fatal(err)
							}
						case "cancel":
							if err := owner.Call(ctx, "session.cancel", protocol.SessionCancelParams{Session: created.Session}, nil); err != nil {
								t.Fatal(err)
							}
						case "disconnect":
							owner.Close()
						}
					case <-ctx.Done():
						t.Fatal(ctx.Err())
					}
					break
				}
			}
			answered := false
			for {
				select {
				case fact := <-facts:
					if fact.Type == question.Answered {
						answer, err := event.Decode[question.Answer](fact)
						if err != nil || !answer.Cancelled {
							t.Fatalf("question answer=%+v error=%v", answer, err)
						}
						answered = true
					}
					if fact.Type == loop.TurnFinished {
						outcome, err := event.Decode[loop.Outcome](fact)
						expected := loop.Answered
						if action == "cancel" {
							expected = loop.Cancelled
						}
						if err != nil || outcome.Stop != expected || !answered {
							t.Fatalf("outcome=%+v answered=%v error=%v", outcome, answered, err)
						}
						return
					}
				case <-ctx.Done():
					t.Fatal(ctx.Err())
				}
			}
		})
	}
}
