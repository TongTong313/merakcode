package engine_test

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"

	"github.com/TongTong313/merakcode/merak/engine"
	"github.com/TongTong313/merakcode/merak/engine/agent"
	"github.com/TongTong313/merakcode/merak/engine/event"
	"github.com/TongTong313/merakcode/merak/engine/group"
	"github.com/TongTong313/merakcode/merak/engine/leader"
	"github.com/TongTong313/merakcode/merak/engine/loop"
	"github.com/TongTong313/merakcode/merak/engine/model"
	"github.com/TongTong313/merakcode/merak/engine/model/fake"
	"github.com/TongTong313/merakcode/merak/engine/permission"
	"github.com/TongTong313/merakcode/merak/engine/prompt"
	"github.com/TongTong313/merakcode/merak/engine/session"
	"github.com/TongTong313/merakcode/merak/engine/store"
	"github.com/TongTong313/merakcode/merak/engine/task"
	"github.com/TongTong313/merakcode/merak/engine/worker"
	"github.com/TongTong313/merakcode/merak/internal/platform/process"
)

func TestExternalLeaderSteersAnActiveTurnInsteadOfStartingAnother(t *testing.T) {
	ctx, cancel := context.WithTimeout(t.Context(), 12*time.Second)
	defer cancel()
	binary := filepath.Join(t.TempDir(), "claude.exe")
	if output, err := process.Command(ctx, "", "go", "build", "-o", binary, "./worker/claudecode/testdata/fakeclaude").CombinedOutput(); err != nil {
		t.Fatalf("build=%s %v", output, err)
	}
	e, err := engine.New(engine.Deps{Workdir: t.TempDir(), MCPCommand: os.Args[0]})
	if err != nil {
		t.Fatal(err)
	}
	defer e.Close()
	lead := agent.DefaultMerakCode()
	lead.ID, lead.Mode = "lead", permission.ModeTakeover
	lead.Product = &agent.Product{Kind: worker.KindClaudeCode, Binary: binary, Args: []string{"--leader-boundary"}}
	g, err := createGroup(t, e, ctx, group.Group{Kind: group.KindLocal, Name: "Steering", Project: group.Project{Directory: t.TempDir()}, Leader: "leader"}, []group.Member{{ID: "leader", Name: "Leader", Kind: group.MemberAgent, AgentRole: group.AgentLeader, Agent: lead.ID}, {ID: "owner", Name: "Owner", Kind: group.MemberHuman, Role: group.RoleOwner}}, []agent.Agent{lead})
	if err != nil {
		t.Fatal(err)
	}
	facts, stop := e.Bus.Subscribe(event.Filter{Scope: event.Scope{Group: g.ID}, Types: []event.Type{session.MessageSent, loop.TurnFinished}})
	defer stop()
	card, err := e.CreateTask(ctx, task.Card{Group: g.ID, Title: "Receive steering", CreatedBy: event.Actor{Kind: event.ActorHuman, ID: "owner"}})
	if err != nil {
		t.Fatal(err)
	}
	select {
	case <-facts:
	case <-ctx.Done():
		t.Fatal("first input did not start")
	}
	if _, err = e.SayGroup(ctx, g.ID, card.ID, "owner", group.Message{Text: "Continue this active turn", To: []event.ID{"leader"}}); err != nil {
		t.Fatal(err)
	}
	inputs := 1
	for {
		select {
		case fact := <-facts:
			if fact.Type == session.MessageSent {
				inputs++
			}
			if fact.Type == loop.TurnFinished {
				if inputs != 2 {
					t.Fatalf("inputs=%d", inputs)
				}
				return
			}
		case <-ctx.Done():
			t.Fatal("the active turn was not steered")
		}
	}
}

func TestExternalLeaderCreatesChildAndRepliesThroughTheSameProcess(t *testing.T) {
	runExternalLeaderFixture(t, worker.KindClaudeCode)
}

func TestAnAgentOfAProductTakesTheLeaderSeatOnlyWithMCPAndSteering(t *testing.T) {
	e, err := engine.New(engine.Deps{Workdir: t.TempDir()})
	if err != nil {
		t.Fatal(err)
	}
	defer e.Close()
	for _, kind := range []worker.Kind{worker.KindClaudeCode, worker.KindCodex, worker.KindPi, worker.KindACP, worker.KindOpenCode, worker.KindCommand} {
		t.Run(string(kind), func(t *testing.T) {
			// No agent is a Leader by nature: every product agent can be saved, and the seat decides.
			p := agent.DefaultMerakCode()
			p.Name, p.Product = string(kind)+" agent", &agent.Product{Kind: kind, Binary: "fixture"}
			saved, err := e.SaveAgent(t.Context(), "owner", p)
			if err != nil {
				t.Fatalf("the agent was not saved: %v", err)
			}
			g, err := e.CreateGroup(t.Context(), group.Group{Kind: group.KindLocal, Name: "Seats", Project: group.Project{Directory: t.TempDir()}, Leader: "lead"}, []group.Member{
				{ID: "owner", Name: "Owner", Kind: group.MemberHuman, Role: group.RoleOwner},
				{ID: "lead", Name: "Lead", Kind: group.MemberAgent, AgentRole: group.AgentLeader, Agent: "builtin-merakcode"},
			})
			if err != nil {
				t.Fatal(err)
			}
			_, err = e.UpdateGroup(t.Context(), g.ID, "owner", group.Update{Leader: &saved.ID})
			allowed := kind == worker.KindClaudeCode || kind == worker.KindCodex || kind == worker.KindPi
			if (err == nil) != allowed {
				t.Fatalf("allowed=%v error=%v", allowed, err)
			}
		})
	}
}

func TestCodexAndPiLeadersKeepTheirProcessesAcrossBatches(t *testing.T) {
	for _, kind := range []worker.Kind{worker.KindCodex, worker.KindPi} {
		t.Run(string(kind), func(t *testing.T) { runExternalLeaderFixture(t, kind) })
	}
}

func runExternalLeaderFixture(t *testing.T, kind worker.Kind) {
	t.Helper()
	ctx, cancel := context.WithTimeout(t.Context(), 40*time.Second)
	defer cancel()
	bin := t.TempDir()
	claude, merak := filepath.Join(bin, "claude.exe"), filepath.Join(bin, "merak.exe")
	folder, fixture := string(kind), string(kind)
	if kind == worker.KindClaudeCode {
		folder, fixture = "claudecode", "claude"
	}
	for _, build := range []struct{ path, source string }{{claude, "./worker/" + folder + "/testdata/fake" + fixture}, {merak, "../cmd/merak"}} {
		if os.Getenv("MERAKCODE_TEST_CLAUDE") != "" {
			break
		}
		if output, err := process.Command(ctx, "", "go", "build", "-o", build.path, build.source).CombinedOutput(); err != nil {
			t.Fatalf("build=%s %v", output, err)
		}
	}
	if supplied := os.Getenv("MERAKCODE_TEST_CLAUDE"); supplied != "" {
		claude, merak = supplied, os.Getenv("MERAKCODE_TEST_MERAK")
	}
	directory := t.TempDir()
	if runtime.GOOS != "windows" {
		t.Setenv("HOME", t.TempDir())
	}
	e, err := engine.New(engine.Deps{MCPCommand: merak, Workdir: directory, Providers: map[string]model.Provider{"group": groupScript{name: "group", test: t, reply: func(model.Request) fake.Reply { return fake.Reply{Text: "Waiting"} }}, "worker": fake.New(t, integrationCall("bash", map[string]any{"command": "echo approved"}), integrationCall("submit_report", map[string]any{"verdict": "done", "summary": "External leader approved."}))}})
	if err != nil {
		t.Fatal(err)
	}
	defer e.Close()
	defaultLeader, external := agent.DefaultMerakCode(), agent.DefaultMerakCode()
	defaultLeader.ID, defaultLeader.Model.Provider = "default-profile", "group"
	external.ID, external.Mode = "external-profile", permission.ModeTakeover
	external.Budget.MaxSteps = 3
	external.Product = &agent.Product{Kind: kind, Binary: claude, Env: map[string]string{"MERAKCODE_FIXTURE_MCP": "1", "MERAKCODE_FIXTURE_LEADER": "1", "MERAKCODE_FIXTURE_APPROVAL": "never"}}
	if kind == worker.KindClaudeCode {
		external.Product.Args = []string{"--mcp-leader"}
	}
	work := agent.DefaultMerakCode()
	work.ID, work.Model.Provider, work.Mode = "worker-profile", "worker", permission.ModeAuto
	g, err := createGroup(t, e, ctx, group.Group{Name: "External leader", Kind: group.KindLocal, Leader: "external", Project: group.Project{Directory: directory}}, []group.Member{{ID: "external", Name: "External", Kind: group.MemberAgent, AgentRole: group.AgentLeader, Agent: external.ID}, {ID: "worker", Name: "Worker", Kind: group.MemberAgent, AgentRole: group.AgentWorker, Agent: work.ID}, {ID: "owner", Name: "Owner", Kind: group.MemberHuman, Role: group.RoleOwner}}, []agent.Agent{defaultLeader, external, work})
	if err != nil {
		t.Fatal(err)
	}
	root, err := e.CreateTask(ctx, task.Card{Group: g.ID, Title: "Coordinate fixture", CreatedBy: event.Actor{Kind: event.ActorHuman, ID: "owner"}})
	if err != nil {
		t.Fatal(err)
	}
	facts, stop := e.Bus.Subscribe(event.Filter{Scope: event.Scope{Group: g.ID}, Types: []event.Type{session.MessageCompleted}})
	defer stop()
	var pid string
	for _, text := range []string{"Create fixture child " + string(root.ID), "Reply fixture", "Reply fixture"} {
		if _, err := e.SayGroup(ctx, g.ID, root.ID, "owner", group.Message{Text: text, To: []event.ID{"external"}}); err != nil {
			t.Fatal(err)
		}
	wait:
		for {
			select {
			case fact := <-facts:
				if fact.Actor.ID != "external" {
					continue
				}
				completion, _ := event.Decode[session.Completion](fact)
				if len(completion.Parts) == 0 || !strings.HasPrefix(completion.Parts[0].Text, "Fixture PID ") {
					continue
				}
				if pid == "" {
					pid = completion.Parts[0].Text
				} else if pid != completion.Parts[0].Text {
					t.Fatal("leader process changed between batches")
				}
				break wait
			case <-ctx.Done():
				t.Fatal("external leader did not reply")
			}
		}
	}
	cards, err := e.Tasks.List(ctx, g.ID)
	if err != nil || len(cards) != 2 {
		t.Fatalf("cards=%+v %v", cards, err)
	}
	for _, card := range cards {
		if card.ID != root.ID && (card.Parent != root.ID || card.Title != "Fixture child") {
			t.Fatalf("child=%+v", card)
		}
	}
	status, err := e.SandboxStatus(ctx, directory, permission.ModeAuto)
	if err != nil {
		t.Fatal(err)
	}
	if status.Available {
		reports, stopReports := e.Bus.Subscribe(event.Filter{Scope: event.Scope{Group: g.ID}, Types: []event.Type{task.Reported}})
		defer stopReports()
		if _, err := e.SayGroup(ctx, g.ID, root.ID, "owner", group.Message{Text: "Assign fixture worker", To: []event.ID{"external"}}); err != nil {
			t.Fatal(err)
		}
		select {
		case fact := <-reports:
			card, err := event.Decode[task.Card](fact)
			if err != nil || len(card.Claims) != 1 || card.Claims[0].Report == nil || card.Claims[0].Report.Summary != "External leader approved." {
				t.Fatalf("report=%+v %v", card, err)
			}
		case <-time.After(8 * time.Second):
			t.Fatal("external leader did not assign and approve the worker")
		}
		approvals, err := e.FindEvents(ctx, store.Query{Scope: event.Scope{Group: g.ID}, Types: []event.Type{permission.Replied}})
		if err != nil || len(approvals) == 0 {
			t.Fatalf("approvals=%v %v", approvals, err)
		}
		for _, fact := range approvals {
			reply, _ := event.Decode[permission.Reply](fact)
			if reply.Leader != "external" || reply.Decision != permission.Allow {
				t.Fatalf("reply=%+v", reply)
			}
		}
	}
	inputs, err := e.FindEvents(ctx, store.Query{Scope: event.Scope{Group: g.ID}, Types: []event.Type{session.MessageSent}})
	if err != nil || len(inputs) == 0 {
		t.Fatalf("inputs=%v %v", inputs, err)
	}
	first, _ := event.Decode[model.Message](inputs[0])
	body, _ := json.Marshal(first)
	identity := strings.Split((prompt.Composer{}).System(prompt.Situation{Role: "leader"}), "\n\n")[0]
	var firstText strings.Builder
	for _, part := range first.Parts {
		firstText.WriteString(part.Text)
	}
	if !strings.Contains(firstText.String(), identity) || !strings.Contains(firstText.String(), string(root.ID)) {
		t.Fatalf("first message lacks shared leader template and task: %s", body)
	}
	paused, stopPaused := e.Bus.Subscribe(event.Filter{Scope: event.Scope{Group: g.ID}, Types: []event.Type{"group.paused"}})
	defer stopPaused()
	if _, err := e.SayGroup(ctx, g.ID, root.ID, "owner", group.Message{Text: "Exit fixture", To: []event.ID{"external"}}); err != nil {
		t.Fatal(err)
	}
	select {
	case <-paused:
	case <-time.After(4 * time.Second):
		t.Fatal("leader process exit was not reported")
	}
	if kind == worker.KindClaudeCode {
		handed, stop := e.Bus.Subscribe(event.Filter{Scope: event.Scope{Group: g.ID}, Types: []event.Type{leader.ThreadHandedOver}})
		defer stop()
		next := defaultLeader.ID
		if _, err := e.UpdateGroup(ctx, g.ID, "owner", group.Update{Leader: &next}); err != nil {
			t.Fatal(err)
		}
		select {
		case fact := <-handed:
			value, err := event.Decode[leader.Handover](fact)
			if err != nil || value.Summary != "Fixture handover" {
				t.Fatalf("handover=%+v %v", value, err)
			}
		case <-time.After(5 * time.Second):
			t.Fatal("external leader did not hand over")
		}
	}
}
