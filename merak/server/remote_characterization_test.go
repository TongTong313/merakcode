package server_test

import (
	"context"
	"encoding/json"
	"errors"
	"regexp"
	"strings"
	"testing"
	"time"

	"github.com/TongTong313/merakcode/merak/cloudlink"
	"github.com/TongTong313/merakcode/merak/engine"
	"github.com/TongTong313/merakcode/merak/engine/agent/definition"
	"github.com/TongTong313/merakcode/merak/engine/agent/model"
	"github.com/TongTong313/merakcode/merak/engine/agent/model/fake"
	"github.com/TongTong313/merakcode/merak/engine/collab/coordinator"
	"github.com/TongTong313/merakcode/merak/engine/collab/group"
	"github.com/TongTong313/merakcode/merak/engine/collab/leader"
	"github.com/TongTong313/merakcode/merak/engine/collab/task"
	"github.com/TongTong313/merakcode/merak/engine/collab/wire"
	"github.com/TongTong313/merakcode/merak/engine/infra/event"
	"github.com/TongTong313/merakcode/merak/server"
	"github.com/TongTong313/merakcode/merak/storage/memory"
	"github.com/TongTong313/merakcode/merak/storage/vault"
	"github.com/TongTong313/merakcode/merak/testkit/enginetest"
)

type remoteQuestionLeader struct {
	test   *testing.T
	answer bool
}

func (remoteQuestionLeader) Name() string { return "question-leader" }

func (p remoteQuestionLeader) Stream(ctx context.Context, request model.Request) (model.Stream, error) {
	reply := fake.Reply{Text: "Waiting."}
	if p.answer && len(request.Messages) > 0 {
		body, _ := json.Marshal(request.Messages[len(request.Messages)-1])
		match := regexp.MustCompile(`Answer remote question ([A-Z0-9]+)`).FindStringSubmatch(string(body))
		if len(match) == 2 {
			input, _ := json.Marshal(map[string]string{"member": "remote-member", "question": match[1], "text": "Use blue."})
			reply = fake.Reply{Calls: []model.ToolCall{{ID: "answer", Name: "message_member", Input: input}}}
		}
	}
	return fake.New(p.test, reply).Stream(ctx, request)
}

// Device-stream questions currently do not wake the host leader. The answered
// scenario explicitly prompts it with a human group message.
func TestRemoteMemberQuestionAcceptsAPromptedLeaderAnswerAndUsesTheHostTimeout(t *testing.T) {
	for _, scenario := range []struct {
		name   string
		answer bool
		wait   time.Duration
	}{{"answered", true, 10 * time.Second}, {"expired", false, 300 * time.Millisecond}} {
		t.Run(scenario.name, func(t *testing.T) {
			ctx, cancel := context.WithTimeout(t.Context(), 15*time.Second)
			defer cancel()
			ending := fake.Reply{Hold: make(chan struct{})}
			if scenario.answer {
				ending = fake.Reply{Expect: func(request model.Request) error {
					body, _ := json.Marshal(request.Messages)
					if !strings.Contains(string(body), "Use blue.") {
						return errors.New("remote member did not receive the host leader answer")
					}
					return nil
				}, Calls: []model.ToolCall{{ID: "report", Name: "submit_report", Input: json.RawMessage(`{"verdict":"done","summary":"Used blue.","artifacts":[],"checks":[]}`)}}}
			}
			provider := fake.New(t, fake.Reply{Calls: []model.ToolCall{{ID: "ask", Name: "ask_leader", Input: json.RawMessage(`{"text":"Which color should I use?"}`)}}}, ending)
			deps := enginetest.Deps(t)
			deps.Workdir = t.TempDir()
			deps.Store = memory.New()
			deps.Providers = map[string]model.Provider{"fake": provider}
			device, err := engine.New(deps)
			if err != nil {
				t.Fatal(err)
			}
			defer device.Close()
			workerProfile := definition.DefaultMerakCode()
			workerProfile.ID, workerProfile.Model.Provider = "source-worker", "fake"
			if _, err = device.SaveAgent(ctx, "owner", workerProfile); err != nil {
				t.Fatal(err)
			}
			if _, err = device.CreateGroup(ctx, group.Group{ID: "source", Kind: group.KindLocal, Name: "Source", Leader: "leader", Project: group.Project{Directory: t.TempDir()}}, []group.Member{
				{ID: "leader", Name: "Leader", Kind: group.MemberAgent, AgentRole: group.AgentLeader, Agent: "builtin-merakcode"},
				{ID: "worker", Name: "Worker", Kind: group.MemberAgent, AgentRole: group.AgentWorker, Agent: workerProfile.ID},
			}); err != nil {
				t.Fatal(err)
			}
			instance, err := server.Start(device, t.TempDir())
			if err != nil {
				t.Fatal(err)
			}
			defer instance.Close()
			deps2 := enginetest.Deps(t)
			deps2.Dial = cloudlink.Dial
			deps2.Workdir = t.TempDir()
			deps2.DataDir = t.TempDir()
			deps2.Dirs = enginetest.Dirs(t, deps2.DataDir)
			deps2.Store = memory.New()
			deps2.Vault = vault.NewMemory()
			deps2.Providers = map[string]model.Provider{"question-leader": remoteQuestionLeader{test: t, answer: scenario.answer}}
			host, err := engine.New(deps2)
			if err != nil {
				t.Fatal(err)
			}
			defer host.Close()
			connection, err := host.ConnectRemote(ctx, wire.RemoteConnectParams{Endpoint: instance.Info.Endpoint, Token: instance.Info.Token})
			if err != nil {
				t.Fatal(err)
			}
			remoteProfile := definition.DefaultMerakCode()
			remoteProfile.ID = "remote-worker"
			remoteProfile.Product = &definition.Product{Kind: definition.KindRemote, Remote: &definition.RemoteSource{Connection: connection.ID, Group: "source", Member: "worker"}}
			leadProfile := definition.DefaultMerakCode()
			leadProfile.ID, leadProfile.Model.Provider = "host-leader", "question-leader"
			g, err := createGroup(t, host, ctx, group.Group{Kind: group.KindLocal, Name: "Host", Project: group.Project{Directory: t.TempDir()}, Leader: "leader", Settings: group.Settings{ApprovalTimeout: scenario.wait}}, []group.Member{
				{ID: "leader", Name: "Leader", Kind: group.MemberAgent, AgentRole: group.AgentLeader, Agent: leadProfile.ID},
				{ID: "remote-member", Name: "Remote", Kind: group.MemberAgent, AgentRole: group.AgentWorker, Agent: remoteProfile.ID, Remote: true},
				{ID: "owner", Name: "Owner", Kind: group.MemberHuman, Role: group.RoleOwner},
			}, []definition.Agent{leadProfile, remoteProfile})
			if err != nil {
				t.Fatal(err)
			}
			facts, stop := host.Subscribe(event.Filter{Scope: event.Scope{Group: g.ID}})
			defer stop()
			card, err := host.CreateAssignedTask(ctx, task.Card{Group: g.ID, Title: "Choose a color", Workspace: "none", CreatedBy: event.Actor{Kind: event.ActorHuman, ID: "owner"}}, "remote-member")
			if err != nil {
				t.Fatal(err)
			}
			var asked event.Event
			for {
				select {
				case fact := <-facts:
					if fact.Type == group.MemberAsked {
						asked = fact
						if scenario.answer {
							if _, err := host.SayGroup(ctx, g.ID, card.ID, "owner", group.Message{Text: "Answer remote question " + string(fact.ID) + ".", To: []event.ID{"leader"}}); err != nil {
								t.Fatal(err)
							}
						}
					}
					if scenario.answer && fact.Type == task.Reported {
						result, err := event.Decode[task.Card](fact)
						if err != nil || len(result.Claims) != 1 || result.Claims[0].Report.Summary != "Used blue." || result.Claims[0].Report.Verdict != task.VerdictDone {
							t.Fatalf("reported task = %+v, error = %v", result, err)
						}
						if asked.ID == "" || asked.Actor.ID != "remote-member" || asked.Scope.Task != card.ID {
							t.Fatalf("imported question = %+v", asked)
						}
						original, err := device.GetEvent(ctx, asked.ID)
						if err != nil || original.Stream != asked.Stream || original.Seq != asked.Seq {
							t.Fatalf("original question = %+v, error = %v", original, err)
						}
						return
					}
					if !scenario.answer && fact.Type == coordinator.SentinelFlagged {
						finding, err := event.Decode[leader.Finding](fact)
						if err != nil || finding.Rule != "approval.timeout" || finding.Code != "MRK-6002" || finding.Task != card.ID || finding.Member != "remote-member" || len(finding.Evidence) != 1 || finding.Evidence[0] != asked.ID {
							t.Fatalf("timeout finding = %+v, question = %s, error = %v", finding, asked.ID, err)
						}
						saved, err := host.Task(ctx, card.ID)
						if err != nil || saved.Status != task.Blocked {
							t.Fatalf("timed out task = %+v, error = %v", saved, err)
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
