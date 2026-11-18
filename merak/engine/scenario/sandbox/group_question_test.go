package sandbox_test

import (
	"context"
	"encoding/json"
	"fmt"
	"regexp"
	"strings"
	"testing"
	"time"

	"github.com/TongTong313/merakcode/merak/engine"
	"github.com/TongTong313/merakcode/merak/engine/agent/definition"
	"github.com/TongTong313/merakcode/merak/engine/agent/loop"
	"github.com/TongTong313/merakcode/merak/engine/agent/model"
	"github.com/TongTong313/merakcode/merak/engine/agent/model/fake"
	"github.com/TongTong313/merakcode/merak/engine/agent/question"
	"github.com/TongTong313/merakcode/merak/engine/collab/group"
	"github.com/TongTong313/merakcode/merak/engine/collab/task"
	"github.com/TongTong313/merakcode/merak/engine/infra/event"
	"github.com/TongTong313/merakcode/merak/testkit/enginetest"
)

func TestLeaderQuestionUsesTheGroupThreadAndHumanQuestionDoesNotBlockTheLeader(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	answer := make(chan question.Answer, 1)
	var workerQuestion string
	expression := regexp.MustCompile(`Event (\S+) \(member.asked\)`)
	leadModel := enginetest.GroupScript{ProviderName: "leader", Test: t, Reply: func(req model.Request) fake.Reply {
		latest, _ := json.Marshal(req.Messages[len(req.Messages)-1])
		text := string(latest)
		if match := expression.FindStringSubmatch(text); len(match) == 2 {
			workerQuestion = match[1]
			for _, spec := range req.Tools {
				if spec.Name == "ask_human" && !strings.Contains(string(spec.Input), `"to"`) {
					t.Error("human question schema omitted the named recipient")
				}
			}
			return enginetest.IntegrationCall("ask_human", map[string]any{"text": "Which color?", "to": "human", "options": []string{"blue", "red"}})
		}
		if strings.Contains(text, "(question.answered)") {
			if !strings.Contains(text, "blue") {
				t.Error("leader did not receive human answer")
			}
			return enginetest.IntegrationCall("message_member", map[string]any{"member": "worker", "question": workerQuestion, "text": "Use blue."})
		}
		return fake.Reply{Text: "Waiting."}
	}}
	report := enginetest.IntegrationCall("submit_report", map[string]any{"verdict": "done", "summary": "Used blue."})
	report.Expect = func(req model.Request) error {
		body, _ := json.Marshal(req.Messages)
		if !strings.Contains(string(body), "Use blue.") {
			return fmt.Errorf("worker did not receive leader answer")
		}
		return nil
	}
	dir := t.TempDir()
	deps := enginetest.Deps(t)
	deps.Workdir = dir
	deps.Providers = map[string]model.Provider{"leader": leadModel, "worker": fake.New(t, enginetest.IntegrationCall("ask_leader", map[string]any{"text": "Which color should I use?"}), report)}
	deps.AskQuestion = func(ctx context.Context, request question.Request) (question.Answer, error) {
		if request.Text != "Which color?" || request.To != "human" {
			t.Errorf("question=%+v", request)
		}
		select {
		case value := <-answer:
			return value, nil
		case <-ctx.Done():
			return question.Answer{}, ctx.Err()
		}
	}
	e, err := engine.New(deps)
	if err != nil {
		t.Fatal(err)
	}
	defer e.Close()
	lead, work := definition.DefaultMerakCode(), definition.DefaultMerakCode()
	lead.ID, lead.Model.Provider = "leader-profile", "leader"
	work.ID, work.Model.Provider = "worker-profile", "worker"
	g, err := enginetest.CreateGroup(t, e, ctx, group.Group{Kind: group.KindLocal, Name: "Project", Project: group.Project{Directory: dir}, Leader: "leader"}, []group.Member{
		{ID: "human", Name: "Owner", Kind: group.MemberHuman, Role: "owner"},
		{ID: "leader", Name: "Leader", Kind: group.MemberAgent, AgentRole: group.AgentLeader, Agent: lead.ID},
		{ID: "worker", Name: "Worker", Kind: group.MemberAgent, AgentRole: group.AgentWorker, Agent: work.ID},
	}, []definition.Agent{lead, work})
	if err != nil {
		t.Fatal(err)
	}
	facts, stop := e.Subscribe(event.Filter{Scope: event.Scope{Group: g.ID}})
	defer stop()
	_, err = e.CreateAssignedTask(ctx, task.Card{Group: g.ID, Title: "Choose color", CreatedBy: event.Actor{Kind: event.ActorHuman, ID: "human"}}, "worker")
	if err != nil {
		t.Fatal(err)
	}
	var humanQuestion event.Event
	finishedBeforeAnswer := false
	for {
		select {
		case fact := <-facts:
			if fact.Type == question.Answered && fact.Actor.ID != "human" {
				t.Errorf("answer lost the responding human: %+v", fact.Actor)
			}
			if fact.Type == question.Asked {
				humanQuestion = fact
				if fact.Scope.Group != g.ID || fact.Stream != event.Stream("group:"+g.ID) {
					t.Fatalf("question escaped its group thread: %+v", fact)
				}
			}
			if humanQuestion.ID != "" && fact.Type == loop.TurnFinished && fact.Scope.Session == humanQuestion.Scope.Session && !finishedBeforeAnswer {
				finishedBeforeAnswer = true
				answer <- question.Answer{Text: "blue"}
			}
			if fact.Type == task.Reported {
				result, err := event.Decode[task.Card](fact)
				if err != nil || !finishedBeforeAnswer || result.Claims[0].Report.Summary != "Used blue." {
					t.Fatalf("report=%+v finished=%v err=%v", result, finishedBeforeAnswer, err)
				}
				return
			}
		case <-ctx.Done():
			t.Fatal(ctx.Err())
		}
	}
}
