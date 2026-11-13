package engine_test

import (
	"context"
	"encoding/json"
	"fmt"
	"github.com/TongTong313/merakcode/merak/engine"
	"net"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/TongTong313/merakcode/merak/engine/agent"
	"github.com/TongTong313/merakcode/merak/engine/event"
	"github.com/TongTong313/merakcode/merak/engine/group"
	"github.com/TongTong313/merakcode/merak/engine/loop"
	"github.com/TongTong313/merakcode/merak/engine/mcp"
	"github.com/TongTong313/merakcode/merak/engine/model"
	"github.com/TongTong313/merakcode/merak/engine/model/fake"
	"github.com/TongTong313/merakcode/merak/engine/permission"
	"github.com/TongTong313/merakcode/merak/engine/session"
	"github.com/TongTong313/merakcode/merak/engine/store"
	memorystore "github.com/TongTong313/merakcode/merak/engine/store/memory"
	"github.com/TongTong313/merakcode/merak/engine/tool"
	"github.com/TongTong313/merakcode/merak/engine/worker"
	"github.com/TongTong313/merakcode/merak/internal/platform/config"
	"github.com/TongTong313/merakcode/merak/internal/platform/process"
)

func TestWorkspaceConfirmationSurvivesEngineRestartWithTheSameRequest(t *testing.T) {
	ctx, cancel := context.WithTimeout(t.Context(), 8*time.Second)
	defer cancel()
	directory := t.TempDir()
	if err := os.WriteFile(filepath.Join(directory, "merakcode.json"), []byte(`{"mcp":{"docs":{"type":"local","command":["missing"]}}}`), 0600); err != nil {
		t.Fatal(err)
	}
	storage, settings := memorystore.New(), config.NewMemory()
	requests := make(chan permission.Request, 2)
	deps := engine.Deps{Store: storage, NetworkSettings: settings, Workdir: directory, Providers: map[string]model.Provider{"fake": fake.New(t, fake.Reply{Text: "Ready"})}, Ask: func(ctx context.Context, req permission.Request) (permission.Reply, error) {
		requests <- req
		<-ctx.Done()
		return permission.Reply{}, ctx.Err()
	}}
	e, err := engine.New(deps)
	if err != nil {
		t.Fatal(err)
	}
	defer e.Close()
	id, err := e.CreateSession(ctx, engine.SessionOptions{Provider: "fake"})
	if err != nil {
		t.Fatal(err)
	}
	turns, stop := e.Bus.Subscribe(event.Filter{Scope: event.Scope{Session: id}, Types: []event.Type{loop.TurnFinished}})
	defer stop()
	if err := e.Send(ctx, id, []model.Part{{Text: "Begin"}}); err != nil {
		t.Fatal(err)
	}
	var original permission.Request
	select {
	case original = <-requests:
	case <-ctx.Done():
		t.Fatal(ctx.Err())
	}
	select {
	case <-turns:
	case <-ctx.Done():
		t.Fatal(ctx.Err())
	}
	if err := e.Close(); err != nil {
		t.Fatal(err)
	}
	deps.Ask = func(_ context.Context, req permission.Request) (permission.Reply, error) {
		requests <- req
		return permission.Reply{Decision: permission.Allow}, nil
	}
	restored, err := engine.New(deps)
	if err != nil {
		t.Fatal(err)
	}
	defer restored.Close()
	if err := restored.Recover(ctx); err != nil {
		t.Fatal(err)
	}
	select {
	case req := <-requests:
		if req.ID != original.ID {
			t.Fatalf("request changed: %s -> %s", original.ID, req.ID)
		}
	case <-ctx.Done():
		t.Fatal("pending confirmation was not recovered")
	}
	for len(settings.Private().WorkspaceTrust) != 1 {
		select {
		case <-ctx.Done():
			t.Fatal("recovered reply was not saved")
		case <-time.After(time.Millisecond):
		}
	}
}

func TestBuiltinMCPFixtureProcess(t *testing.T) {
	if os.Getenv("MERAKCODE_BUILTIN_MCP_FIXTURE") != "1" {
		return
	}
	if path := os.Getenv("MERAKCODE_MCP_LIFETIME_FILE"); path != "" {
		listener, err := net.Listen("tcp4", "127.0.0.1:0")
		if err != nil || os.WriteFile(path, []byte(listener.Addr().String()), 0600) != nil {
			os.Exit(1)
		}
		defer listener.Close()
	}
	var operation tool.Tool = tool.ReadFile{}
	if name := os.Getenv("MERAKCODE_MCP_TOOL_NAME"); name != "" {
		operation = namedMCPFixture{Tool: operation, name: name}
	}
	server := mcp.Server{Tools: tool.NewPool("fixture", operation), Env: tool.Env{Workdir: ".", Reads: new(tool.Reads)}}
	_ = server.Serve(context.Background(), os.Stdin, os.Stdout)
	os.Exit(0)
}

type namedMCPFixture struct {
	tool.Tool
	name string
}

func (f namedMCPFixture) Spec() tool.Spec { spec := f.Tool.Spec(); spec.Name = f.name; return spec }

func TestMCPNameCollisionSkipsTheConflictingServer(t *testing.T) {
	command, _ := os.Executable()
	servers := make(map[string]config.MCPServer)
	for server, name := range map[string]string{"a": "b__c", "a__b": "c"} {
		servers[server] = config.MCPServer{Command: command, Args: []string{"-test.run=^TestBuiltinMCPFixtureProcess$"}, Env: map[string]string{"MERAKCODE_BUILTIN_MCP_FIXTURE": "1", "MERAKCODE_MCP_TOOL_NAME": name}}
	}
	body, _ := config.MCPFile(servers), error(nil)
	path := filepath.Join(t.TempDir(), "merakcode.json")
	if err := os.WriteFile(path, body, 0600); err != nil {
		t.Fatal(err)
	}
	settings, err := config.Open(filepath.Dir(path))
	if err != nil {
		t.Fatal(err)
	}
	e, err := engine.New(engine.Deps{NetworkSettings: settings, Workdir: t.TempDir(), Providers: map[string]model.Provider{"fake": fake.New(t, fake.Reply{Text: "Ready"})}})
	if err != nil {
		t.Fatal(err)
	}
	defer e.Close()
	if _, err := e.Chat(t.Context(), "fake", "List tools"); err != nil {
		t.Fatal(err)
	}
	facts, err := e.FindEvents(t.Context(), store.Query{Types: []event.Type{session.Warning}})
	if err != nil {
		t.Fatal(err)
	}
	for _, fact := range facts {
		warning, _ := event.Decode[session.Diagnostic](fact)
		if warning.Code == "MRK-5010" && warning.Server == "a__b" {
			return
		}
	}
	t.Fatal("colliding server was not skipped")
}

func TestUserMCPOverridesWorkspaceAndStopsWhenTheTakeoverSessionEnds(t *testing.T) {
	directory := t.TempDir()
	if err := os.WriteFile(filepath.Join(directory, "note.txt"), []byte("owned server"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(directory, "merakcode.json"), []byte(`{"mcp":{"docs":{"type":"local","command":["missing-workspace-command"]}}}`), 0600); err != nil {
		t.Fatal(err)
	}
	command, _ := os.Executable()
	body, _ := config.MCPFile(map[string]config.MCPServer{"docs": {Command: command, Args: []string{"-test.run=^TestBuiltinMCPFixtureProcess$"}, Env: map[string]string{"MERAKCODE_BUILTIN_MCP_FIXTURE": "1", "MERAKCODE_MCP_LIFETIME_FILE": filepath.Join(directory, "mcp-address")}}}), error(nil)
	path := filepath.Join(t.TempDir(), "merakcode.json")
	if err := os.WriteFile(path, body, 0600); err != nil {
		t.Fatal(err)
	}
	settings, err := config.Open(filepath.Dir(path))
	if err != nil {
		t.Fatal(err)
	}
	address := ""
	provider := fake.New(t, fake.Reply{Text: "Ready", Expect: func(req model.Request) error {
		if !strings.Contains(req.System, "mcp__docs__read_file") {
			return fmt.Errorf("user server was not selected")
		}
		data, err := os.ReadFile(filepath.Join(directory, "mcp-address"))
		if err != nil {
			return err
		}
		address = string(data)
		connection, err := net.DialTimeout("tcp", address, time.Second)
		if err == nil {
			connection.Close()
		}
		return err
	}})
	e, err := engine.New(engine.Deps{NetworkSettings: settings, Providers: map[string]model.Provider{"fake": provider}, Ask: func(context.Context, permission.Request) (permission.Reply, error) {
		t.Error("overridden server requested trust")
		return permission.Reply{Decision: permission.Deny}, nil
	}})
	if err != nil {
		t.Fatal(err)
	}
	defer e.Close()
	p := agent.DefaultMerakCode()
	p.Mode, p.Model.Provider = permission.ModeTakeover, "fake"
	run, err := e.StartWorker(t.Context(), p, worker.Assignment{Session: "takeover-session", Workdir: directory, Packet: "List tools"})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := run.Wait(t.Context()); err != nil {
		t.Fatal(err)
	}
	if address == "" {
		t.Fatal("server did not start")
	}
	connection, err := net.DialTimeout("tcp", address, time.Second)
	if err == nil {
		connection.Close()
		t.Fatal("server survived its session")
	}
}

func TestMCPToolsUseTheDeferredPoolAndGateWhileBrokenServersAreSkipped(t *testing.T) {
	directory := t.TempDir()
	if err := os.WriteFile(filepath.Join(directory, "note.txt"), []byte("verified MCP file"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(directory, "merakcode.json"), []byte(`{"model":5}`), 0600); err != nil {
		t.Fatal(err)
	}
	command, _ := os.Executable()
	body := config.MCPFile(map[string]config.MCPServer{
		"docs":   {Command: command, Args: []string{"-test.run=^TestBuiltinMCPFixtureProcess$"}, Env: map[string]string{"MERAKCODE_BUILTIN_MCP_FIXTURE": "1"}},
		"broken": {Command: filepath.Join(directory, "missing-server")},
	})
	path := filepath.Join(t.TempDir(), "merakcode.json")
	if err := os.WriteFile(path, body, 0600); err != nil {
		t.Fatal(err)
	}
	settings, err := config.Open(filepath.Dir(path))
	if err != nil {
		t.Fatal(err)
	}
	provider := fake.New(t,
		fake.Reply{Calls: []model.ToolCall{{ID: "load", Name: "load_tools", Input: json.RawMessage(`{"names":["mcp__docs__read_file"]}`)}}},
		fake.Reply{Calls: []model.ToolCall{{ID: "read", Name: "call_tool", Input: json.RawMessage(`{"name":"mcp__docs__read_file","input":{"path":"note.txt"}}`)}}},
		fake.Reply{Text: "Finished", Expect: func(req model.Request) error {
			body, _ := json.Marshal(req.Messages)
			if !strings.Contains(string(body), "verified MCP file") {
				return fmt.Errorf("MCP result missing")
			}
			return nil
		}},
	)
	var asked int
	e, err := engine.New(engine.Deps{Workdir: directory, NetworkSettings: settings, Providers: map[string]model.Provider{"fake": provider}, Ask: func(_ context.Context, req permission.Request) (permission.Reply, error) {
		asked++
		if req.Spec.Name != "mcp__docs__read_file" || req.Spec.Effect != tool.EffectExec {
			t.Errorf("MCP bypassed exec gate: %+v", req)
		}
		return permission.Reply{Decision: permission.Allow}, nil
	}})
	if err != nil {
		t.Fatal(err)
	}
	defer e.Close()
	if _, err := e.Chat(t.Context(), "fake", "Read the fixture"); err != nil {
		t.Fatal(err)
	}
	if asked != 1 {
		t.Fatalf("approvals=%d", asked)
	}
	facts, err := e.FindEvents(t.Context(), store.Query{Types: []event.Type{session.Warning}})
	if err != nil {
		t.Fatal(err)
	}
	codes := map[string]bool{}
	for _, fact := range facts {
		value, err := event.Decode[session.Diagnostic](fact)
		if err != nil {
			t.Fatal(err)
		}
		codes[value.Code] = true
	}
	if !codes["MRK-3002"] || !codes["MRK-5010"] {
		t.Fatalf("warnings=%v", codes)
	}
}

func TestWorkspaceMCPTrustIsSharedByTwoWorktreesOfTheGroupProject(t *testing.T) {
	ctx := t.Context()
	project := t.TempDir()
	git := func(args ...string) {
		t.Helper()
		if out, err := process.Command(ctx, project, "git", args...).CombinedOutput(); err != nil {
			t.Fatalf("git: %s %v", out, err)
		}
	}
	git("init")
	git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.com", "commit", "--allow-empty", "-m", "Initial fixture")
	first, second := filepath.Join(t.TempDir(), "first"), filepath.Join(t.TempDir(), "second")
	git("worktree", "add", "--detach", first, "HEAD")
	git("worktree", "add", "--detach", second, "HEAD")
	command, _ := os.Executable()
	definition := config.MCPServer{Command: command, Args: []string{"-test.run=^TestBuiltinMCPFixtureProcess$"}, Env: map[string]string{"MERAKCODE_BUILTIN_MCP_FIXTURE": "1"}}
	body, _ := config.MCPFile(map[string]config.MCPServer{"docs": definition}), error(nil)
	for _, directory := range []string{first, second} {
		if err := os.WriteFile(filepath.Join(directory, "merakcode.json"), body, 0600); err != nil {
			t.Fatal(err)
		}
	}
	settings := config.NewMemory()
	resolved, _ := filepath.EvalSymlinks(project)
	if err := settings.RememberWorkspaceTrust(config.Trust{Project: resolved, Item: "mcpServers/docs", Hash: definition.Hash(), Decision: "allow"}); err != nil {
		t.Fatal(err)
	}
	e, err := engine.New(engine.Deps{NetworkSettings: settings, Providers: map[string]model.Provider{"fake": mcpConfigurationProbe{}}, Ask: func(context.Context, permission.Request) (permission.Reply, error) {
		t.Error("another worktree asked again")
		return permission.Reply{Decision: permission.Deny}, nil
	}})
	if err != nil {
		t.Fatal(err)
	}
	defer e.Close()
	p := agent.DefaultMerakCode()
	p.ID = "worker-profile"
	p.Model.Provider, p.Model.Model = "fake", "fixture"
	if _, err := e.SaveAgent(ctx, "owner", p); err != nil {
		t.Fatal(err)
	}
	g, err := e.Groups.Create(ctx, group.Group{Kind: group.KindLocal, Name: "Worktrees", Leader: "leader", Project: group.Project{Directory: project}}, []group.Member{{ID: "leader", Name: "Leader", Kind: group.MemberAgent, AgentRole: group.AgentLeader}, {ID: "worker", Name: "Worker", Kind: group.MemberAgent, AgentRole: group.AgentWorker, Agent: p.ID}, {ID: "owner", Name: "Owner", Kind: group.MemberHuman, Role: group.RoleOwner}})
	if err != nil {
		t.Fatal(err)
	}
	for _, directory := range []string{first, second} {
		id, err := e.CreateSession(ctx, engine.SessionOptions{Scope: event.Scope{Group: g.ID}, Member: "worker", Workdir: directory, Provider: "fake", Mode: permission.ModeTakeover})
		if err != nil {
			t.Fatal(err)
		}
		runMCPTestTurn(t, e, id)
		if !mcpAdvertised(t, e, id) {
			t.Fatal("shared trust was not used")
		}
	}
}

func TestWorkspaceMCPConfirmationAppliesOnlyToLaterSessions(t *testing.T) {
	directory := t.TempDir()
	command, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	definition := config.MCPServer{Command: command, Args: []string{"-test.run=^TestBuiltinMCPFixtureProcess$"}, Env: map[string]string{"MERAKCODE_BUILTIN_MCP_FIXTURE": "1", "PRIVATE_VALUE": "never-in-events"}}
	write := func(prefix string, server config.MCPServer) {
		t.Helper()
		body, _ := config.MCPFile(map[string]config.MCPServer{"docs": server}), error(nil)
		if err := os.WriteFile(filepath.Join(directory, "merakcode.jsonc"), append([]byte(prefix), body...), 0600); err != nil {
			t.Fatal(err)
		}
	}
	write("", definition)
	settings := config.NewMemory()
	var asked atomic.Int32
	answers := make(chan permission.Reply, 4)
	requests := make(chan permission.Request, 4)
	e, err := engine.New(engine.Deps{NetworkSettings: settings, Workdir: directory, Providers: map[string]model.Provider{"fake": mcpConfigurationProbe{}}, Ask: func(ctx context.Context, req permission.Request) (permission.Reply, error) {
		asked.Add(1)
		requests <- req
		select {
		case reply := <-answers:
			return reply, nil
		case <-ctx.Done():
			return permission.Reply{}, ctx.Err()
		}
	}})
	if err != nil {
		t.Fatal(err)
	}
	defer e.Close()
	newSession := func() event.ID {
		t.Helper()
		id, err := e.CreateSession(t.Context(), engine.SessionOptions{Provider: "fake", Mode: permission.ModeTakeover})
		if err != nil {
			t.Fatal(err)
		}
		runMCPTestTurn(t, e, id)
		return id
	}
	first := newSession()
	if mcpAdvertised(t, e, first) {
		t.Fatal("unconfirmed server started")
	}
	select {
	case req := <-requests:
		body, _ := json.Marshal(req)
		if req.Kind != "workspace" || strings.Contains(string(body), "never-in-events") || !strings.Contains(string(body), "PRIVATE_VALUE") {
			t.Fatalf("unsafe request: %s", body)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("confirmation missing")
	}
	second := newSession()
	if mcpAdvertised(t, e, second) || asked.Load() != 1 {
		t.Fatal("pending confirmation was duplicated or server started")
	}
	answers <- permission.Reply{Decision: permission.Allow}
	project, _ := filepath.EvalSymlinks(directory)
	deadline := time.Now().Add(3 * time.Second)
	for settings.WorkspaceDecision(project, "mcpServers/docs", definition.Hash()) == "" {
		if time.Now().After(deadline) {
			t.Fatal("confirmation was not saved")
		}
		time.Sleep(time.Millisecond)
	}
	runMCPTestTurn(t, e, first)
	if mcpAdvertised(t, e, first) {
		t.Fatal("confirmation changed an existing session")
	}
	third := newSession()
	if !mcpAdvertised(t, e, third) {
		t.Fatal("confirmed server did not start in the next session")
	}
	write("// revised comment\n", definition)
	fourth := newSession()
	if !mcpAdvertised(t, e, fourth) || asked.Load() != 1 {
		t.Fatal("comment change altered trust")
	}
	definition.Args = append(definition.Args, "-test.v")
	write("", definition)
	if mcpAdvertised(t, e, newSession()) {
		t.Fatal("changed server reused old trust")
	}
	select {
	case <-requests:
	case <-time.After(3 * time.Second):
		t.Fatal("changed server was not confirmed")
	}
	answers <- permission.Reply{Decision: permission.Deny}
	deadline = time.Now().Add(3 * time.Second)
	for settings.WorkspaceDecision(project, "mcpServers/docs", definition.Hash()) != "deny" {
		if time.Now().After(deadline) {
			t.Fatal("denial was not saved")
		}
		time.Sleep(time.Millisecond)
	}
	if mcpAdvertised(t, e, newSession()) || asked.Load() != 2 {
		t.Fatal("denied server started or asked again")
	}
	facts, err := e.FindEvents(t.Context(), store.Query{})
	if err != nil {
		t.Fatal(err)
	}
	for _, fact := range facts {
		if strings.Contains(string(fact.Payload), "never-in-events") {
			t.Fatal("configuration secret reached events")
		}
	}
}

func TestWorkspaceConfirmationRemainsInSnapshotAfterTheTurnFinishes(t *testing.T) {
	directory := t.TempDir()
	if err := os.WriteFile(filepath.Join(directory, "merakcode.json"), []byte(`{"mcp":{"docs":{"type":"local","command":["missing-command"]}}}`), 0600); err != nil {
		t.Fatal(err)
	}
	requested := make(chan struct{}, 1)
	e, err := engine.New(engine.Deps{Workdir: directory, Providers: map[string]model.Provider{"fake": fake.New(t, fake.Reply{Text: "Finished"})}, Ask: func(ctx context.Context, _ permission.Request) (permission.Reply, error) {
		requested <- struct{}{}
		<-ctx.Done()
		return permission.Reply{}, ctx.Err()
	}})
	if err != nil {
		t.Fatal(err)
	}
	defer e.Close()
	id, err := e.CreateSession(t.Context(), engine.SessionOptions{Provider: "fake"})
	if err != nil {
		t.Fatal(err)
	}
	finished := runMCPTestTurn(t, e, id)
	select {
	case <-requested:
	case <-time.After(3 * time.Second):
		t.Fatal("no confirmation")
	}
	deadline := time.Now().Add(3 * time.Second)
	for {
		snapshot, err := e.SessionSnapshot(t.Context(), id)
		if err != nil {
			t.Fatal(err)
		}
		if snapshot.LastSeq >= finished {
			if len(snapshot.Permissions) != 1 {
				t.Fatalf("pending=%v", snapshot.Permissions)
			}
			for _, pending := range snapshot.Permissions {
				if pending.Request.Kind != "workspace" {
					t.Fatalf("pending=%+v", pending)
				}
			}
			return
		}
		if time.Now().After(deadline) {
			t.Fatal("snapshot did not finish")
		}
		time.Sleep(time.Millisecond)
	}
}

type mcpConfigurationProbe struct{}

func TestStandaloneWorktreesShareAnActualMCPConfirmation(t *testing.T) {
	ctx := t.Context()
	project := integrationRepository(t)
	first, second := filepath.Join(t.TempDir(), "first"), filepath.Join(t.TempDir(), "second")
	fixtureGit(t, project, "worktree", "add", "--detach", first, "HEAD")
	fixtureGit(t, project, "worktree", "add", "--detach", second, "HEAD")
	command, _ := os.Executable()
	definition := config.MCPServer{Command: command, Args: []string{"-test.run=^TestBuiltinMCPFixtureProcess$"}, Env: map[string]string{"MERAKCODE_BUILTIN_MCP_FIXTURE": "1"}}
	body, _ := config.MCPFile(map[string]config.MCPServer{"docs": definition}), error(nil)
	settings := config.NewMemory()
	var asked atomic.Int32
	for i, directory := range []string{first, second} {
		if err := os.WriteFile(filepath.Join(directory, "merakcode.jsonc"), append([]byte("// Worktree configuration\n"), body...), 0600); err != nil {
			t.Fatal(err)
		}
		e, err := engine.New(engine.Deps{Workdir: directory, NetworkSettings: settings, Providers: map[string]model.Provider{"fake": mcpConfigurationProbe{}}, Ask: func(context.Context, permission.Request) (permission.Reply, error) {
			asked.Add(1)
			return permission.Reply{Decision: permission.Allow}, nil
		}})
		if err != nil {
			t.Fatal(err)
		}
		id, err := e.CreateSession(ctx, engine.SessionOptions{Provider: "fake", Mode: permission.ModeTakeover})
		if err != nil {
			t.Fatal(err)
		}
		runMCPTestTurn(t, e, id)
		if got := mcpAdvertised(t, e, id); got != (i == 1) {
			t.Errorf("worktree %d advertised=%t", i, got)
		}
		if i == 0 {
			deadline := time.After(5 * time.Second)
			for len(settings.Private().WorkspaceTrust) == 0 {
				select {
				case <-deadline:
					t.Fatal("confirmation was not persisted")
				case <-time.After(time.Millisecond):
				}
			}
		}
		if err := e.Close(); err != nil {
			t.Fatal(err)
		}
	}
	if asked.Load() != 1 {
		t.Fatalf("worktrees requested %d confirmations", asked.Load())
	}
}

func (mcpConfigurationProbe) Name() string { return "fake" }
func (mcpConfigurationProbe) Stream(ctx context.Context, req model.Request) (model.Stream, error) {
	return fake.New(nil, fake.Reply{Text: req.System}).Stream(ctx, req)
}

func runMCPTestTurn(t *testing.T, e *engine.Engine, id event.ID) uint64 {
	t.Helper()
	facts, stop := e.Bus.Subscribe(event.Filter{Scope: event.Scope{Session: id}, Types: []event.Type{loop.TurnFinished}})
	defer stop()
	if err := e.Send(t.Context(), id, []model.Part{{Text: "Continue"}}); err != nil {
		t.Fatal(err)
	}
	select {
	case fact := <-facts:
		return fact.Seq
	case <-time.After(5 * time.Second):
		t.Fatal("MCP test turn did not finish")
	}
	return 0
}
func mcpAdvertised(t *testing.T, e *engine.Engine, id event.ID) bool {
	t.Helper()
	facts, err := e.FindEvents(t.Context(), store.Query{Scope: event.Scope{Session: id}, Types: []event.Type{session.MessageCompleted}})
	if err != nil || len(facts) == 0 {
		t.Fatalf("model completions=%v %v", facts, err)
	}
	message, err := event.Decode[session.Completion](facts[len(facts)-1])
	if err != nil {
		t.Fatal(err)
	}
	for _, part := range message.Parts {
		if strings.Contains(part.Text, "mcp__docs__read_file") {
			return true
		}
	}
	return false
}
