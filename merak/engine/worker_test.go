package engine_test

import (
	"context"
	"errors"
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
	"github.com/TongTong313/merakcode/merak/engine/loop"
	"github.com/TongTong313/merakcode/merak/engine/model"
	"github.com/TongTong313/merakcode/merak/engine/model/fake"
	"github.com/TongTong313/merakcode/merak/engine/permission"
	"github.com/TongTong313/merakcode/merak/engine/session"
	"github.com/TongTong313/merakcode/merak/engine/task"
	"github.com/TongTong313/merakcode/merak/engine/worker"
	"github.com/TongTong313/merakcode/merak/internal/platform/process"
	"github.com/TongTong313/merakcode/merak/internal/platform/sandbox"
)

func approveFixtureStartup(_ context.Context, request permission.Request) (permission.Reply, error) {
	if request.Kind == "launch" {
		return permission.Reply{Decision: permission.Allow}, nil
	}
	return permission.Reply{Decision: permission.Deny}, nil
}

func TestExternalWorkerCancellationRetainsOutputAndClosesPendingCalls(t *testing.T) {
	for _, kind := range []worker.Kind{"command", "codex", "pi", "acp", "opencode"} {
		t.Run(string(kind), func(t *testing.T) {
			ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
			defer cancel()
			binary := filepath.Join(t.TempDir(), string(kind)+".exe")
			build := process.Command(ctx, "", "go", "build", "-o", binary, "./worker/"+string(kind)+"/testdata/fake"+string(kind))
			if out, err := build.CombinedOutput(); err != nil {
				t.Fatalf("build: %s %v", out, err)
			}
			e, err := engine.New(engine.Deps{Ask: func(ctx context.Context, request permission.Request) (permission.Reply, error) {
				if request.Kind == "launch" {
					return permission.Reply{Decision: permission.Allow}, nil
				}
				<-ctx.Done()
				return permission.Reply{}, ctx.Err()
			}})
			if err != nil {
				t.Fatal(err)
			}
			defer e.Close()
			p := agent.DefaultWorker()
			p.Product = &agent.Product{Kind: kind, Binary: binary, Env: map[string]string{"MERAKCODE_FIXTURE_MODE": "hold"}}
			run, err := e.StartWorker(ctx, p, worker.Assignment{Session: "session", Workdir: t.TempDir(), Packet: "Verify", Claim: task.Claim{ID: "claim"}})
			if err != nil {
				t.Fatal(err)
			}
			for {
				fact, ok := <-run.Events()
				if !ok {
					t.Fatal("worker ended before cancellation")
				}
				if fact.Type == permission.Requested {
					request, err := event.Decode[permission.Request](fact)
					if err != nil {
						t.Fatal(err)
					}
					if request.Kind == "launch" {
						continue
					}
				}
				if fact.Type == session.MessageDelta || fact.Type == permission.Requested {
					break
				}
			}
			if err := run.Cancel(ctx); err != nil {
				t.Fatal(err)
			}
			report, err := run.Wait(ctx)
			if !errors.Is(err, context.Canceled) || report.Verdict != task.VerdictBlocked {
				t.Fatalf("report=%+v err=%v", report, err)
			}
			if kind != "acp" && kind != "opencode" && report.Summary != "Waiting" {
				t.Fatalf("partial output lost: %+v", report)
			}
			state, err := e.SessionSnapshot(ctx, "session")
			if err != nil {
				t.Fatal(err)
			}
			facts, err := e.ReadEvents(ctx, "session:session", state.LastSeq+1, 100)
			if err != nil {
				t.Fatal(err)
			}
			for _, fact := range facts {
				if err := session.Fold(&state, fact); err != nil {
					t.Fatal(err)
				}
			}
			if len(state.Open) != 0 || state.Status == session.Running {
				t.Fatalf("unfinished state=%+v", state)
			}
		})
	}
}

func TestCodexAndPiAcceptMessagesDuringExecution(t *testing.T) {
	for _, kind := range []worker.Kind{"codex", "pi"} {
		t.Run(string(kind), func(t *testing.T) {
			ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
			defer cancel()
			binary := filepath.Join(t.TempDir(), string(kind)+".exe")
			build := process.Command(ctx, "", "go", "build", "-o", binary, "./worker/"+string(kind)+"/testdata/fake"+string(kind))
			if out, err := build.CombinedOutput(); err != nil {
				t.Fatalf("build: %s %v", out, err)
			}
			e, err := engine.New(engine.Deps{Ask: approveFixtureStartup})
			if err != nil {
				t.Fatal(err)
			}
			defer e.Close()
			p := agent.DefaultWorker()
			p.Product = &agent.Product{Kind: kind, Binary: binary, Env: map[string]string{"MERAKCODE_FIXTURE_MODE": "steer"}}
			run, err := e.StartWorker(ctx, p, worker.Assignment{Session: "session", Workdir: t.TempDir(), Packet: "Verify"})
			if err != nil {
				t.Fatal(err)
			}
			for fact := range run.Events() {
				if fact.Type == session.MessageDelta {
					break
				}
			}
			if err := run.Send(ctx, loop.Input{Parts: []model.Part{{Text: "Changed instruction"}}}); err != nil {
				t.Fatal(err)
			}
			report, err := run.Wait(ctx)
			if err != nil || report.Summary != "Changed instruction" {
				t.Fatalf("report=%+v err=%v", report, err)
			}
		})
	}
}

func TestExternalReworkKeepsTheSessionAndPreviousContext(t *testing.T) {
	for _, kind := range []worker.Kind{"codex", "acp", "opencode", "pi", "command"} {
		t.Run(string(kind), func(t *testing.T) {
			ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
			defer cancel()
			binary := filepath.Join(t.TempDir(), string(kind)+".exe")
			build := process.Command(ctx, "", "go", "build", "-o", binary, "./worker/"+string(kind)+"/testdata/fake"+string(kind))
			if out, err := build.CombinedOutput(); err != nil {
				t.Fatalf("build: %s %v", out, err)
			}
			e, err := engine.New(engine.Deps{Ask: approveFixtureStartup})
			if err != nil {
				t.Fatal(err)
			}
			defer e.Close()
			p := agent.DefaultWorker()
			p.Product = &agent.Product{Kind: kind, Binary: binary, Env: map[string]string{"MERAKCODE_FIXTURE_MODE": "history"}}
			a := worker.Assignment{Session: "session", Workdir: t.TempDir(), Packet: "Original brief", Claim: task.Claim{ID: "claim", Member: "member"}}
			for _, text := range []string{"Original brief", "Rework"} {
				a.Packet = text
				run, err := e.StartWorker(ctx, p, a)
				if err != nil {
					t.Fatal(err)
				}
				report, err := run.Wait(ctx)
				if err != nil {
					t.Fatalf("report=%+v err=%v", report, err)
				}
				if text == "Rework" && kind != "command" && report.Summary != "Preserved original context" {
					t.Fatalf("lost context: %+v", report)
				}
			}
			facts, err := e.ReadEvents(ctx, "session:session", 1, 100)
			if err != nil {
				t.Fatal(err)
			}
			created := 0
			var state session.State
			for _, fact := range facts {
				if fact.Type == session.Created {
					created++
				}
				if err := session.Fold(&state, fact); err != nil {
					t.Fatal(err)
				}
			}
			if created != 1 || len(state.Messages) < 4 {
				t.Fatalf("created=%d messages=%v", created, state.Messages)
			}
		})
	}
}

func TestEngineStartsEveryExternalWorkerKind(t *testing.T) {
	for _, kind := range []worker.Kind{"codex", "opencode", "pi", "acp", "command"} {
		t.Run(string(kind), func(t *testing.T) {
			ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
			defer cancel()
			binary := filepath.Join(t.TempDir(), string(kind)+".exe")
			cmd := process.Command(ctx, "", "go", "build", "-o", binary, "./worker/"+string(kind)+"/testdata/fake"+string(kind))
			if out, err := cmd.CombinedOutput(); err != nil {
				t.Fatalf("build: %s %v", out, err)
			}
			e, err := engine.New(engine.Deps{Ask: func(context.Context, permission.Request) (permission.Reply, error) {
				return permission.Reply{Decision: permission.Allow}, nil
			}})
			if err != nil {
				t.Fatal(err)
			}
			defer e.Close()
			_, err = e.Groups.Create(ctx, group.Group{ID: "group", Kind: group.KindLocal, Name: "Group", Project: group.Project{Directory: t.TempDir()}, Leader: "leader"}, []group.Member{
				{ID: "leader", Name: "Leader", Kind: group.MemberAgent, AgentRole: group.AgentLeader},
				{ID: "member", Name: "Worker", Kind: group.MemberAgent, AgentRole: group.AgentWorker},
				{ID: "human", Name: "Owner", Kind: group.MemberHuman, Role: group.RoleOwner},
			})
			if err != nil {
				t.Fatal(err)
			}
			p := agent.DefaultWorker()
			p.Product = &agent.Product{Kind: kind, Binary: binary}
			if _, err := e.Tasks.Create(ctx, task.Card{ID: "task", Group: "group", Title: "Verify"}); err != nil {
				t.Fatal(err)
			}
			if kind == "pi" {
				fixture, err := filepath.Abs("worker/pi/testdata/conversation.jsonl")
				if err != nil {
					t.Fatal(err)
				}
				p.Product.Args = []string{"--fixture", fixture}
			}
			run, err := e.StartWorker(ctx, p, worker.Assignment{Session: "session", Scope: event.Scope{Group: "group", Task: "task"}, Workdir: t.TempDir(), Packet: "Verify", Claim: task.Claim{ID: "claim", Member: "member"}})
			if err != nil {
				t.Fatal(err)
			}
			report, err := run.Wait(ctx)
			if err != nil || report.Verdict != task.VerdictDone {
				t.Fatalf("report=%+v err=%v", report, err)
			}
			state, err := e.SessionSnapshot(ctx, "session")
			if err != nil {
				t.Fatal(err)
			}
			facts, err := e.ReadEvents(ctx, "session:session", state.LastSeq+1, 100)
			if err != nil {
				t.Fatal(err)
			}
			for _, fact := range facts {
				if err := session.Fold(&state, fact); err != nil {
					t.Fatal(err)
				}
			}
			if err != nil || len(state.Messages) < 2 || state.Config.Provider != string(kind) {
				t.Fatalf("state=%+v err=%v", state, err)
			}
			for fact := range run.Events() {
				if fact.Scope.Group != "group" || fact.Scope.Task != "task" {
					t.Fatalf("scope=%+v", fact.Scope)
				}
			}
		})
	}
}

func TestARegisteredMemberRunsOneAssignmentAtATime(t *testing.T) {
	ctx, cancel := context.WithTimeout(t.Context(), 3*time.Second)
	defer cancel()
	entered := make(chan struct{})
	provider := fake.New(t, fake.Reply{Hold: make(chan struct{}), Expect: func(model.Request) error { close(entered); return nil }}, fake.Reply{Text: "Unexpected concurrent reply"})
	e, err := engine.New(engine.Deps{Providers: map[string]model.Provider{"fake": provider}})
	if err != nil {
		t.Fatal(err)
	}
	defer e.Close()
	p := agent.DefaultWorker()
	p.Model.Provider = "fake"
	a := worker.Assignment{Session: "first-assignment", Claim: task.Claim{ID: "first-claim", Member: "registered-member"}, Workdir: t.TempDir(), Packet: "First"}
	first, err := e.StartWorker(ctx, p, a)
	if err != nil {
		t.Fatal(err)
	}
	select {
	case <-entered:
	case <-ctx.Done():
		t.Fatal(ctx.Err())
	}
	a.Session, a.Claim.ID = "second-assignment", "second-claim"
	waiting, stop := context.WithTimeout(ctx, 50*time.Millisecond)
	defer stop()
	second, err := e.StartWorker(waiting, p, a)
	if err == nil || second != nil {
		t.Fatal("a registered member executed two assignments concurrently")
	}
	if err := first.Cancel(ctx); err != nil {
		t.Fatal(err)
	}
}

func TestReadonlyProfileRestrictsExternalProductTools(t *testing.T) {
	dir := t.TempDir()
	name := "claude-fixture"
	if runtime.GOOS == "windows" {
		name += ".exe"
	}
	binary := filepath.Join(t.TempDir(), name)
	cmd := process.Command(t.Context(), "", "go", "build", "-o", binary, "./worker/claudecode/testdata/fakeclaude")
	if output, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("fixture build: %v %s", err, output)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	e, err := engine.New(engine.Deps{Workdir: dir, Ask: approveFixtureStartup})
	if err != nil {
		t.Fatal(err)
	}
	defer e.Close()
	p := agent.DefaultWorker()
	p.ToolPool = "worker.readonly"
	p.Product = &agent.Product{Kind: worker.KindClaudeCode, Binary: binary}
	run, err := e.StartWorker(ctx, p, worker.Assignment{Session: "readonly", Workdir: dir, Packet: "Research only"})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := run.Wait(ctx); err != nil {
		t.Fatal(err)
	}
	allowed, err := os.ReadFile(filepath.Join(dir, "tools.txt"))
	if err != nil || string(allowed) != "Read,Grep,Glob" {
		t.Fatalf("external tool restriction=%q err=%v", allowed, err)
	}
}

func TestReadonlyAssignmentsConstrainOrRejectExternalProducts(t *testing.T) {
	for _, kind := range []worker.Kind{"codex", "opencode", "pi", "acp", "command"} {
		t.Run(string(kind), func(t *testing.T) {
			ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
			defer cancel()
			binary := filepath.Join(t.TempDir(), string(kind)+".exe")
			build := process.Command(ctx, "", "go", "build", "-o", binary, "./worker/"+string(kind)+"/testdata/fake"+string(kind))
			if out, err := build.CombinedOutput(); err != nil {
				t.Fatalf("build: %s %v", out, err)
			}
			asked, launches := 0, 0
			e, err := engine.New(engine.Deps{Ask: func(_ context.Context, request permission.Request) (permission.Reply, error) {
				if request.Kind == "launch" {
					launches++
					return permission.Reply{Decision: permission.Allow}, nil
				}
				asked++
				return permission.Reply{Decision: permission.Allow}, nil
			}})
			if err != nil {
				t.Fatal(err)
			}
			defer e.Close()
			p := agent.DefaultWorker()
			p.ToolPool = "worker.readonly"
			p.Product = &agent.Product{Kind: kind, Binary: binary, Env: map[string]string{"MERAKCODE_FIXTURE_READONLY": "1"}}
			if kind == "pi" {
				fixture, err := filepath.Abs("worker/pi/testdata/conversation.jsonl")
				if err != nil {
					t.Fatal(err)
				}
				p.Product.Args = []string{"--fixture", fixture}
			}
			run, err := e.StartWorker(ctx, p, worker.Assignment{Session: "session", Workdir: t.TempDir(), Packet: "Research"})
			if kind == "acp" || kind == "command" {
				if err == nil {
					_ = run.Cancel(ctx)
					t.Fatal("unsupported read-only assignment started")
				}
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			report, err := run.Wait(ctx)
			if err != nil || asked != 0 || report.Verdict != task.VerdictDone {
				t.Fatalf("report=%+v err=%v asked=%d", report, err, asked)
			}
			wantLaunches := 0
			if kind == worker.KindPi && !(&sandbox.Launcher{}).Status(ctx, sandbox.Profile{}).Available {
				wantLaunches = 1
			}
			if launches != wantLaunches {
				t.Errorf("startup approvals=%d, want %d", launches, wantLaunches)
			}
			if kind != "pi" && report.Summary != "Denied" {
				t.Fatalf("write request was allowed: %+v", report)
			}
		})
	}
}

func TestWorkerUsesProfileInstructionsAndKeepsGroupAttribution(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "AGENTS.md"), []byte("Verify the result."), 0600); err != nil {
		t.Fatal(err)
	}
	p := fake.New(t, fake.Reply{Text: `{"verdict":"done","summary":"Verified worker result"}`, Expect: func(req model.Request) error {
		if !strings.Contains(req.System, "Verify the result.") || !strings.Contains(req.System, "Focus on tests.") {
			t.Errorf("profile or workspace instructions missing")
		}
		for _, spec := range req.Tools {
			if spec.Name == "write_file" {
				t.Errorf("readonly worker received a write tool")
			}
		}
		return nil
	}})
	e, err := engine.New(engine.Deps{Workdir: dir, Providers: map[string]model.Provider{"fake": p}})
	if err != nil {
		t.Fatal(err)
	}
	defer e.Close()
	config := agent.DefaultWorker()
	config.Model.Provider = "fake"
	config.System = "Focus on tests."
	config.ToolPool = "worker.readonly"
	_, err = e.Groups.Create(ctx, group.Group{ID: "group", Kind: group.KindLocal, Name: "Group", Project: group.Project{Directory: dir}, Leader: "leader"}, []group.Member{
		{ID: "leader", Name: "Leader", Kind: group.MemberAgent, AgentRole: group.AgentLeader, Agent: "builtin-leader"},
		{ID: "member", Name: "Worker", Kind: group.MemberAgent, AgentRole: group.AgentWorker, Agent: "builtin-worker"},
		{ID: "human", Name: "Owner", Kind: group.MemberHuman, Role: group.RoleOwner},
	})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := e.Tasks.Create(ctx, task.Card{ID: "task", Group: "group", Title: "Verify"}); err != nil {
		t.Fatal(err)
	}
	run, err := e.StartWorker(ctx, config, worker.Assignment{Session: "worker-session", Workdir: dir, Packet: "Verify", Scope: event.Scope{Group: "group", Task: "task"}, Claim: task.Claim{ID: "claim", Member: "member"}})
	if err != nil {
		t.Fatal(err)
	}
	report, err := run.Wait(ctx)
	if err != nil || report.Summary != "Verified worker result" || report.Synthesized {
		t.Fatalf("report=%+v err=%v", report, err)
	}
	count := 0
	for fact := range run.Events() {
		if fact.Scope.Group != "group" || fact.Scope.Task != "task" || fact.Scope.Session != "worker-session" || fact.Actor.ID != "member" {
			t.Fatalf("lost worker attribution: %+v", fact)
		}
		count++
	}
	if count < 5 {
		t.Fatalf("events=%d", count)
	}
	state, err := e.SessionSnapshot(ctx, "worker-session")
	if err != nil || len(state.Messages) != 2 {
		t.Fatalf("state=%+v err=%v", state, err)
	}
}

func TestTaskWorkerRequestsAReportOnceBeforeSynthesizing(t *testing.T) {
	for _, submit := range []bool{true, false} {
		name := "synthesized"
		if submit {
			name = "submitted"
		}
		t.Run(name, func(t *testing.T) {
			ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
			defer cancel()
			second := fake.Reply{Expect: func(req model.Request) error {
				text := ""
				for _, message := range req.Messages {
					for _, part := range message.Parts {
						text += part.Text
					}
				}
				if !strings.Contains(text, "Please submit your report") {
					t.Error("missing report reminder")
				}
				return nil
			}}
			if submit {
				second.Calls = []model.ToolCall{{ID: "report", Name: "submit_report", Input: []byte(`{"verdict":"done","summary":"Verified after reminder"}`)}}
			}
			p := fake.New(t, fake.Reply{Text: "Initial answer"}, second)
			e, err := engine.New(engine.Deps{Workdir: t.TempDir(), Providers: map[string]model.Provider{"fake": p}})
			if err != nil {
				t.Fatal(err)
			}
			defer e.Close()
			config := agent.DefaultWorker()
			config.Model.Provider = "fake"
			run, err := e.StartWorker(ctx, config, worker.Assignment{Session: "worker", Claim: task.Claim{ID: "claim", Task: "task", Member: "member"}, Packet: "Verify"})
			if err != nil {
				t.Fatal(err)
			}
			report, err := run.Wait(ctx)
			if err != nil || report.Synthesized == submit {
				t.Fatalf("report=%+v err=%v", report, err)
			}
			if !submit && !strings.Contains(report.Summary, "Initial answer") {
				t.Fatalf("last nonempty answer was lost: %+v", report)
			}
			turns := 0
			for fact := range run.Events() {
				if fact.Type == "turn.started" {
					turns++
				}
			}
			if turns != 2 {
				t.Fatalf("turns=%d", turns)
			}
		})
	}
}
