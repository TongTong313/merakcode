package engine_test

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/TongTong313/merakcode/merak/engine"
	"github.com/TongTong313/merakcode/merak/engine/agent"
	"github.com/TongTong313/merakcode/merak/engine/event"
	"github.com/TongTong313/merakcode/merak/engine/group"
	"github.com/TongTong313/merakcode/merak/engine/loop"
	"github.com/TongTong313/merakcode/merak/engine/model"
	"github.com/TongTong313/merakcode/merak/engine/model/catalog"
	"github.com/TongTong313/merakcode/merak/engine/model/fake"
	"github.com/TongTong313/merakcode/merak/engine/permission"
	"github.com/TongTong313/merakcode/merak/engine/session"
	"github.com/TongTong313/merakcode/merak/engine/store"
	"github.com/TongTong313/merakcode/merak/engine/task"
	"github.com/TongTong313/merakcode/merak/engine/worker"
	"github.com/TongTong313/merakcode/merak/internal/platform/process"
)

func TestTaskAndProfileBudgetsAccumulateAcrossClaimSessions(t *testing.T) {
	for _, tc := range []struct {
		name    string
		profile agent.Budget
		task    task.Budget
	}{
		{"task tokens", agent.Budget{}, task.Budget{MaxTokens: 40}},
		{"profile tokens", agent.Budget{MaxTokens: 40}, task.Budget{}},
		{"task cost", agent.Budget{}, task.Budget{MaxCost: .03}},
		{"profile cost", agent.Budget{MaxCost: .03}, task.Budget{}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			ctx, cancel := context.WithTimeout(t.Context(), 10*time.Second)
			defer cancel()
			dir := t.TempDir()
			provider := groupScript{name: "fixture", test: t, reply: func(req model.Request) fake.Reply {
				for _, spec := range req.Tools {
					if spec.Name == "submit_report" {
						reply := integrationCall("submit_report", map[string]any{"verdict": "done", "summary": "Verified"})
						reply.Usage = &model.Usage{Input: 20, Output: 5}
						return reply
					}
				}
				return fake.Reply{Text: "Recorded"}
			}}
			e, err := engine.New(engine.Deps{Workdir: dir, Providers: map[string]model.Provider{"fixture": provider}})
			if err != nil {
				t.Fatal(err)
			}
			defer e.Close()
			e.ConfigureModels([]catalog.Override{{Provider: "fixture", Price: &catalog.Price{Input: 1000, Currency: "USD"}}})
			lead, work := agent.DefaultLeader(), agent.DefaultWorker()
			lead.ID, work.ID = "lead", "work"
			lead.Model.Provider, work.Model.Provider, work.Budget = "fixture", "fixture", tc.profile
			g, err := createGroup(t, e, ctx, group.Group{Kind: group.KindLocal, Name: "Budget", Leader: "leader", Project: group.Project{Directory: dir}}, []group.Member{
				{ID: "owner", Name: "Owner", Kind: group.MemberHuman, Role: group.RoleOwner},
				{ID: "leader", Name: "Leader", Kind: group.MemberAgent, AgentRole: group.AgentLeader, Agent: lead.ID},
				{ID: "worker", Name: "Worker", Kind: group.MemberAgent, AgentRole: group.AgentWorker, Agent: work.ID},
			}, []agent.Agent{lead, work})
			if err != nil {
				t.Fatal(err)
			}
			card, err := e.CreateTask(ctx, task.Card{Group: g.ID, Title: "Bounded task", Workspace: "none", Budget: tc.task})
			if err != nil {
				t.Fatal(err)
			}
			for i, id := range []event.ID{"first", "second"} {
				run, err := e.StartWorker(ctx, work, worker.Assignment{Session: id, Claim: task.Claim{ID: id, Member: "worker", Task: card.ID}, Scope: event.Scope{Group: g.ID, Task: card.ID}, Workdir: dir})
				if err != nil {
					t.Fatal(err)
				}
				report, err := run.Wait(ctx)
				want := task.VerdictDone
				if i == 1 {
					want = task.VerdictBlocked
				}
				if err != nil || report.Verdict != want {
					t.Fatalf("claim %d report=%+v error=%v want=%s", i, report, err, want)
				}
			}
			current, err := e.Tasks.Get(ctx, card.ID)
			if err != nil || current.Status != task.Blocked || current.Phase != task.PhaseStalled {
				t.Fatalf("exhausted task=%+v %v", current, err)
			}
			if err := e.UpdateTask(ctx, card.ID, task.Update{Budget: &task.BudgetIncrease{Tokens: 100, Cost: 1}}, event.Actor{Kind: event.ActorHuman, ID: "owner"}); err != nil {
				t.Fatal(err)
			}
			run, err := e.StartWorker(ctx, work, worker.Assignment{Session: "second", Claim: task.Claim{ID: "second", Member: "worker", Task: card.ID}, Scope: event.Scope{Group: g.ID, Task: card.ID}, Workdir: dir})
			if err != nil {
				t.Fatal(err)
			}
			report, err := run.Wait(ctx)
			if err != nil || report.Verdict != task.VerdictDone {
				t.Fatalf("granted report=%+v %v", report, err)
			}
		})
	}
}

func TestProfileBudgetsStopWorkersWithBlockedReports(t *testing.T) {
	for _, tc := range []struct {
		name, field string
		value       any
		taskBudget  bool
	}{
		{"steps", "maxSteps", 1, false}, {"tokens", "maxTokens", 10, false}, {"cost", "maxCost", .01, false}, {"wall clock", "maxWallClock", int64(20 * time.Millisecond), false}, {"task steps", "maxSteps", 1, true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			ctx, cancel := context.WithTimeout(t.Context(), 10*time.Second)
			defer cancel()
			dir := t.TempDir()
			if err := os.WriteFile(filepath.Join(dir, "file.txt"), []byte("content"), 0600); err != nil {
				t.Fatal(err)
			}
			cost := .02
			first := fake.Reply{Usage: &model.Usage{Input: 20, Output: 5, Cost: cost, CostKnown: true, Currency: "USD"}, Calls: []model.ToolCall{{ID: "read", Name: "read_file", Input: json.RawMessage(`{"path":"file.txt"}`)}}}
			if tc.field == "maxWallClock" {
				first.Hold = make(chan struct{})
			}
			e, err := engine.New(engine.Deps{Workdir: dir, Providers: map[string]model.Provider{"fake": fake.New(t, first, fake.Reply{Text: "Unbounded answer"})}})
			if err != nil {
				t.Fatal(err)
			}
			defer e.Close()
			e.ConfigureModels([]catalog.Override{{Provider: "fake", Price: &catalog.Price{Input: 1000, Currency: "USD"}}})
			p := agent.DefaultWorker()
			p.Model.Provider = "fake"
			body, _ := json.Marshal(map[string]any{"budget": map[string]any{tc.field: tc.value}})
			if err := json.Unmarshal(body, &p); err != nil {
				t.Fatal(err)
			}
			a := worker.Assignment{Session: "budget-session", Claim: task.Claim{ID: "budget-claim", Member: "worker"}, Workdir: dir, Packet: "Read and continue"}
			if tc.taskBudget {
				g, err := e.Groups.Create(ctx, group.Group{Kind: group.KindLocal, Name: "Steps", Leader: "leader", Project: group.Project{Directory: dir}}, []group.Member{{ID: "leader", Name: "Leader", Kind: group.MemberAgent, AgentRole: group.AgentLeader}, {ID: "worker", Name: "Worker", Kind: group.MemberAgent, AgentRole: group.AgentWorker}})
				if err != nil {
					t.Fatal(err)
				}
				card, err := e.Tasks.Create(ctx, task.Card{Group: g.ID, Title: "One step", Budget: task.Budget{MaxSteps: 1}})
				if err != nil {
					t.Fatal(err)
				}
				p.Budget.MaxSteps = 3
				a.Scope = event.Scope{Group: g.ID, Task: card.ID}
			}
			run, err := e.StartWorker(ctx, p, a)
			if err != nil {
				t.Fatal(err)
			}
			report, err := run.Wait(ctx)
			if err != nil || report.Verdict != task.VerdictBlocked {
				t.Fatalf("budget report: %+v %v", report, err)
			}
			facts, err := e.FindEvents(ctx, store.Query{Scope: event.Scope{Session: "budget-session"}, Types: []event.Type{loop.TurnFinished}})
			if err != nil || len(facts) != 1 {
				t.Fatalf("finished: %+v %v", facts, err)
			}
			outcome, err := event.Decode[loop.Outcome](facts[0])
			if err != nil || string(outcome.Stop) != tc.field {
				t.Fatalf("budget outcome: %+v %v", outcome, err)
			}
		})
	}
}

func TestExternalWorkerWallClockBudgetProducesABlockedReport(t *testing.T) {
	binary := filepath.Join(t.TempDir(), "command.exe")
	if out, err := process.Command(t.Context(), "", "go", "build", "-o", binary, "./worker/command/testdata/fakecommand").CombinedOutput(); err != nil {
		t.Fatalf("build: %s %v", out, err)
	}
	ctx, cancel := context.WithTimeout(t.Context(), 3*time.Second)
	defer cancel()
	e, err := engine.New(engine.Deps{})
	if err != nil {
		t.Fatal(err)
	}
	defer e.Close()
	p := agent.DefaultWorker()
	p.Mode = permission.ModeTakeover
	p.Product = &agent.Product{Kind: worker.KindCommand, Binary: binary, Env: map[string]string{"MERAKCODE_FIXTURE_MODE": "hold"}}
	p.Budget.MaxWallClock = 150 * time.Millisecond
	run, err := e.StartWorker(ctx, p, worker.Assignment{Session: "timed", Claim: task.Claim{ID: "claim"}, Workdir: t.TempDir(), Packet: "Wait"})
	if err != nil {
		t.Fatal(err)
	}
	report, err := run.Wait(ctx)
	if err != nil || report.Verdict != task.VerdictBlocked {
		t.Fatalf("report=%+v error=%v", report, err)
	}
	facts, err := e.FindEvents(ctx, store.Query{Scope: event.Scope{Session: "timed"}, Types: []event.Type{loop.TurnFinished}})
	if err != nil || len(facts) != 1 {
		t.Fatalf("finished=%v %v", facts, err)
	}
	outcome, _ := event.Decode[loop.Outcome](facts[0])
	if outcome.Stop != loop.MaxWallClock {
		t.Fatalf("stop=%s", outcome.Stop)
	}
}

func TestExternalWorkerStopsAtReportedUsageLimits(t *testing.T) {
	binary := filepath.Join(t.TempDir(), "pi.exe")
	if out, err := process.Command(t.Context(), "", "go", "build", "-o", binary, "./worker/pi/testdata/fakepi").CombinedOutput(); err != nil {
		t.Fatalf("build: %s %v", out, err)
	}
	for _, tc := range []struct {
		name   string
		budget agent.Budget
		stop   loop.StopReason
	}{
		{"steps", agent.Budget{MaxSteps: 1}, loop.MaxSteps},
		{"tokens", agent.Budget{MaxTokens: 10}, loop.MaxTokens},
		{"cost", agent.Budget{MaxCost: .01}, loop.MaxCost},
	} {
		t.Run(tc.name, func(t *testing.T) {
			ctx, cancel := context.WithTimeout(t.Context(), 5*time.Second)
			defer cancel()
			e, err := engine.New(engine.Deps{})
			if err != nil {
				t.Fatal(err)
			}
			defer e.Close()
			p := agent.DefaultWorker()
			p.Mode, p.Budget = permission.ModeTakeover, tc.budget
			p.Product = &agent.Product{Kind: worker.KindPi, Binary: binary, Env: map[string]string{"MERAKCODE_FIXTURE_MODE": "budget"}}
			run, err := e.StartWorker(ctx, p, worker.Assignment{Session: "budget", Claim: task.Claim{ID: "claim"}, Workdir: t.TempDir(), Packet: "Continue"})
			if err != nil {
				t.Fatal(err)
			}
			report, err := run.Wait(ctx)
			if err != nil || report.Verdict != task.VerdictBlocked {
				t.Fatalf("report=%+v %v", report, err)
			}
			facts, err := e.FindEvents(ctx, store.Query{Scope: event.Scope{Session: "budget"}, Types: []event.Type{loop.TurnFinished}})
			if err != nil || len(facts) != 1 {
				t.Fatalf("finished=%v %v", facts, err)
			}
			outcome, _ := event.Decode[loop.Outcome](facts[0])
			if outcome.Stop != tc.stop {
				t.Fatalf("stop=%s", outcome.Stop)
			}
		})
	}
}

func TestExternalWorkerReworkPreservesTaskBudget(t *testing.T) {
	binary := filepath.Join(t.TempDir(), "pi.exe")
	if out, err := process.Command(t.Context(), "", "go", "build", "-o", binary, "./worker/pi/testdata/fakepi").CombinedOutput(); err != nil {
		t.Fatalf("build: %s %v", out, err)
	}
	ctx, cancel := context.WithTimeout(t.Context(), 10*time.Second)
	defer cancel()
	e, err := engine.New(engine.Deps{})
	if err != nil {
		t.Fatal(err)
	}
	defer e.Close()
	p := agent.DefaultWorker()
	p.Mode, p.Budget.MaxTokens = permission.ModeTakeover, 40
	p.Product = &agent.Product{Kind: worker.KindPi, Binary: binary, Env: map[string]string{"MERAKCODE_FIXTURE_MODE": "budget-rework"}}
	a := worker.Assignment{Session: "rework-budget", Claim: task.Claim{ID: "claim"}, Workdir: t.TempDir(), Packet: "Initial work"}
	for i := 0; i < 2; i++ {
		if i == 1 {
			a.Packet = "Rework"
		}
		run, err := e.StartWorker(ctx, p, a)
		if err != nil {
			t.Fatal(err)
		}
		report, err := run.Wait(ctx)
		want := task.VerdictDone
		if i == 1 {
			want = task.VerdictBlocked
		}
		if err != nil || report.Verdict != want {
			t.Fatalf("run %d report=%+v error=%v want=%s", i, report, err, want)
		}
	}
	if run, err := e.StartWorker(ctx, p, a); err == nil {
		run.Cancel(ctx)
		_, _ = run.Wait(ctx)
		t.Fatal("exhausted worker restarted without a budget grant")
	}
}

func TestCodexWorkerStopsAtReportedTokenUsage(t *testing.T) {
	binary := filepath.Join(t.TempDir(), "codex.exe")
	if out, err := process.Command(t.Context(), "", "go", "build", "-o", binary, "./worker/codex/testdata/fakecodex").CombinedOutput(); err != nil {
		t.Fatalf("build: %s %v", out, err)
	}
	ctx, cancel := context.WithTimeout(t.Context(), 6*time.Second)
	defer cancel()
	e, err := engine.New(engine.Deps{})
	if err != nil {
		t.Fatal(err)
	}
	defer e.Close()
	p := agent.DefaultWorker()
	p.Mode, p.Budget = permission.ModeTakeover, agent.Budget{MaxTokens: 10}
	p.Product = &agent.Product{Kind: worker.KindCodex, Binary: binary, Env: map[string]string{"MERAKCODE_FIXTURE_MODE": "budget", "MERAKCODE_FIXTURE_APPROVAL": "never"}}
	run, err := e.StartWorker(ctx, p, worker.Assignment{Session: "codex-budget", Claim: task.Claim{ID: "claim"}, Workdir: t.TempDir(), Packet: "Continue"})
	if err != nil {
		t.Fatal(err)
	}
	report, err := run.Wait(ctx)
	if err != nil || report.Verdict != task.VerdictBlocked || report.Usage.Input != 20 || report.Usage.Output != 5 {
		t.Fatalf("report=%+v %v", report, err)
	}
}

func TestClaudeMessageFragmentsDoNotConsumeAdditionalSteps(t *testing.T) {
	binary := filepath.Join(t.TempDir(), "claude.exe")
	if out, err := process.Command(t.Context(), "", "go", "build", "-o", binary, "./worker/claudecode/testdata/fakeclaude").CombinedOutput(); err != nil {
		t.Fatalf("build: %s %v", out, err)
	}
	ctx, cancel := context.WithTimeout(t.Context(), 8*time.Second)
	defer cancel()
	dir := t.TempDir()
	fixture := filepath.Join(dir, "fragments.jsonl")
	body := "{\"type\":\"assistant\",\"message\":{\"id\":\"one\",\"content\":[{\"type\":\"text\",\"text\":\"First\"}]}}\n{\"type\":\"assistant\",\"message\":{\"id\":\"one\",\"content\":[{\"type\":\"text\",\"text\":\"Second\"}]}}\n"
	if err := os.WriteFile(fixture, []byte(body), 0600); err != nil {
		t.Fatal(err)
	}
	e, err := engine.New(engine.Deps{})
	if err != nil {
		t.Fatal(err)
	}
	defer e.Close()
	p := agent.DefaultWorker()
	p.Mode, p.Budget = permission.ModeTakeover, agent.Budget{MaxSteps: 2}
	p.Product = &agent.Product{Kind: worker.KindClaudeCode, Binary: binary, Args: []string{"--fixture", fixture, "--fixture-hold"}}
	facts, stop := e.Bus.Subscribe(event.Filter{Types: []event.Type{session.MessageCompleted}})
	defer stop()
	run, err := e.StartWorker(ctx, p, worker.Assignment{Session: "fragments", Claim: task.Claim{ID: "claim"}, Workdir: dir, Packet: "Continue"})
	if err != nil {
		t.Fatal(err)
	}
	for range 2 {
		select {
		case <-facts:
		case <-ctx.Done():
			t.Fatal(ctx.Err())
		}
	}
	wait, done := context.WithTimeout(ctx, 2*time.Second)
	defer done()
	if report, err := run.Wait(wait); !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("fragments exhausted two steps: %+v %v", report, err)
	}
	_ = run.Cancel(ctx)
	_, _ = run.Wait(ctx)
}

func TestGrantedTaskReassignmentContinuesTheOriginalClaimSession(t *testing.T) {
	ctx, cancel := context.WithTimeout(t.Context(), 12*time.Second)
	defer cancel()
	first := integrationCall("submit_report", map[string]any{"verdict": "done", "summary": "First"})
	first.Usage = &model.Usage{Input: 20}
	second := integrationCall("submit_report", map[string]any{"verdict": "done", "summary": "Continued"})
	second.Usage = &model.Usage{Input: 20}
	dir := t.TempDir()
	e, err := engine.New(engine.Deps{Workdir: dir, Providers: map[string]model.Provider{"worker": fake.New(t, first, second), "leader": groupScript{name: "leader", test: t, reply: func(model.Request) fake.Reply { return fake.Reply{Text: "Waiting"} }}}})
	if err != nil {
		t.Fatal(err)
	}
	defer e.Close()
	lead, work := agent.DefaultLeader(), agent.DefaultWorker()
	lead.ID, lead.Model.Provider = "lead", "leader"
	work.ID, work.Model.Provider = "work", "worker"
	g, err := createGroup(t, e, ctx, group.Group{Kind: group.KindLocal, Name: "Budget", Leader: "leader", Project: group.Project{Directory: dir}}, []group.Member{{ID: "leader", Name: "Leader", Kind: group.MemberAgent, AgentRole: group.AgentLeader, Agent: lead.ID}, {ID: "worker", Name: "Worker", Kind: group.MemberAgent, AgentRole: group.AgentWorker, Agent: work.ID}, {ID: "owner", Name: "Owner", Kind: group.MemberHuman, Role: group.RoleOwner}}, []agent.Agent{lead, work})
	if err != nil {
		t.Fatal(err)
	}
	facts, stop := e.Bus.Subscribe(event.Filter{Scope: event.Scope{Group: g.ID}, Types: []event.Type{task.Reported}})
	defer stop()
	card, err := e.CreateAssignedTask(ctx, task.Card{Group: g.ID, Title: "Bounded", Workspace: "none", Budget: task.Budget{MaxTokens: 10}, CreatedBy: event.Actor{Kind: event.ActorHuman, ID: "owner"}}, "worker")
	if err != nil {
		t.Fatal(err)
	}
	receive := func() task.Card {
		t.Helper()
		select {
		case fact := <-facts:
			value, err := event.Decode[task.Card](fact)
			if err != nil {
				t.Fatal(err)
			}
			return value
		case <-ctx.Done():
			t.Fatal(ctx.Err())
			return task.Card{}
		}
	}
	blocked := receive()
	if blocked.Status != task.Blocked {
		t.Fatalf("not blocked: %+v", blocked)
	}
	if err := e.UpdateTask(ctx, card.ID, task.Update{Budget: &task.BudgetIncrease{Tokens: 100}}, event.Actor{Kind: event.ActorHuman, ID: "owner"}); err != nil {
		t.Fatal(err)
	}
	claim, err := e.AssignTask(ctx, card.ID, "owner", "worker", task.RoleOwner, nil)
	if err != nil {
		t.Fatal(err)
	}
	if claim.ID != blocked.Claims[0].ID || claim.Session != blocked.Claims[0].Session {
		t.Fatal("reassignment replaced the claim or session")
	}
	continued := receive()
	if continued.Claims[0].Report.Verdict != task.VerdictDone || continued.Claims[0].Report.Summary != "Continued" {
		t.Fatalf("continuation=%+v", continued)
	}
}

func TestActiveTaskWallClockGrantExtendsRunningWorker(t *testing.T) {
	binary := filepath.Join(t.TempDir(), "pi.exe")
	if out, err := process.Command(t.Context(), "", "go", "build", "-o", binary, "./worker/pi/testdata/fakepi").CombinedOutput(); err != nil {
		t.Fatalf("build: %s %v", out, err)
	}
	for _, external := range []bool{false, true} {
		t.Run(fmt.Sprint(external), func(t *testing.T) {
			ctx, cancel := context.WithTimeout(t.Context(), 8*time.Second)
			defer cancel()
			hold := make(chan struct{})
			e, err := engine.New(engine.Deps{Providers: map[string]model.Provider{"fixture": fake.New(t, fake.Reply{Hold: hold, Text: "Done"})}})
			if err != nil {
				t.Fatal(err)
			}
			defer e.Close()
			p := agent.DefaultWorker()
			p.Model.Provider, p.Mode = "fixture", permission.ModeTakeover
			p.Budget = agent.Budget{MaxWallClock: time.Second}
			if external {
				p.Product = &agent.Product{Kind: worker.KindPi, Binary: binary, Env: map[string]string{"MERAKCODE_FIXTURE_MODE": "budget"}}
			}
			g, err := e.Groups.Create(ctx, group.Group{Name: "Clock", Kind: group.KindLocal, Leader: "leader", Project: group.Project{Directory: t.TempDir()}}, []group.Member{{ID: "leader", Name: "Leader", Kind: group.MemberAgent, AgentRole: group.AgentLeader}, {ID: "worker", Name: "Worker", Kind: group.MemberAgent, AgentRole: group.AgentWorker}, {ID: "owner", Name: "Owner", Kind: group.MemberHuman, Role: group.RoleOwner}})
			if err != nil {
				t.Fatal(err)
			}
			card, err := e.Tasks.Create(ctx, task.Card{Group: g.ID, Title: "Wait", Workspace: "none"})
			if err != nil {
				t.Fatal(err)
			}
			facts, stop := e.Bus.Subscribe(event.Filter{Types: []event.Type{loop.TurnStarted}})
			defer stop()
			run, err := e.StartWorker(ctx, p, worker.Assignment{Session: "clock", Claim: task.Claim{ID: "claim", Member: "worker"}, Scope: event.Scope{Group: g.ID, Task: card.ID}, Workdir: t.TempDir(), Packet: "Wait"})
			if err != nil {
				t.Fatal(err)
			}
			select {
			case <-facts:
			case <-ctx.Done():
				t.Fatal(ctx.Err())
			}
			if err := e.UpdateTask(ctx, card.ID, task.Update{Budget: &task.BudgetIncrease{WallClock: 3 * time.Second}}, event.Actor{Kind: event.ActorHuman, ID: "owner"}); err != nil {
				t.Fatal(err)
			}
			wait, done := context.WithTimeout(ctx, 1500*time.Millisecond)
			defer done()
			if report, err := run.Wait(wait); !errors.Is(err, context.DeadlineExceeded) {
				t.Fatalf("stopped at the original deadline: %+v %v", report, err)
			}
			_ = run.Cancel(ctx)
			_, _ = run.Wait(ctx)
		})
	}
}
