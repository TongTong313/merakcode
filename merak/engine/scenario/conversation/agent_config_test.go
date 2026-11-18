package conversation_test

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/TongTong313/merakcode/merak/engine"
	"github.com/TongTong313/merakcode/merak/engine/agent/conversation"
	"github.com/TongTong313/merakcode/merak/engine/agent/loop"
	"github.com/TongTong313/merakcode/merak/engine/agent/memory"
	"github.com/TongTong313/merakcode/merak/engine/agent/model"
	"github.com/TongTong313/merakcode/merak/engine/agent/model/catalog"
	"github.com/TongTong313/merakcode/merak/engine/agent/model/fake"
	"github.com/TongTong313/merakcode/merak/engine/agent/registry"
	"github.com/TongTong313/merakcode/merak/engine/infra/config"
	"github.com/TongTong313/merakcode/merak/engine/infra/event"
	storage "github.com/TongTong313/merakcode/merak/storage/memory"
	"github.com/TongTong313/merakcode/merak/testkit/enginetest"
)

func modelIs(want string) func(model.Request) error {
	return func(req model.Request) error {
		if req.Model != want {
			return fmt.Errorf("model = %q, want %q", req.Model, want)
		}
		return nil
	}
}

func TestTheTitleAgentChoosesTheModelThatNamesAConversation(t *testing.T) {
	r := enginetest.NewChatRig(t, conversation.SessionOptions{Model: "main"},
		fake.Reply{Text: "Hello there.", Expect: modelIs("main")},
		fake.Reply{Text: "Release plan", Expect: modelIs("titler")},
	)
	r.Engine.ConfigureAgents(registry.AgentSettings{Agents: map[string]config.Agent{"title": {Model: "fake/titler"}}})
	r.Say("Help me plan the release")
	enginetest.WaitFor(t, r.Context, "the title", func() bool { return r.State().Title == "Release plan" })
}

func TestTheSummaryAgentChoosesTheModelThatWritesACommitMessage(t *testing.T) {
	e, repo, ctx := enginetest.CodeEngine(t, fake.Reply{Text: "Rewrite the greeting", Expect: modelIs("summarizer")})
	e.SetDefaultModel("fake", "writer", "")
	e.ConfigureAgents(registry.AgentSettings{Agents: map[string]config.Agent{"summary": {Model: "fake/summarizer"}}})
	if err := os.WriteFile(filepath.Join(repo, "README.md"), []byte("Changed\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	message, err := e.RepoCommitMessage(ctx, repo)
	if err != nil || message != "Rewrite the greeting" {
		t.Fatalf("message=%q err=%v", message, err)
	}
}

func TestTheCompactionAgentChoosesTheModelThatSummarizesAConversation(t *testing.T) {
	r := enginetest.NewChatRig(t, conversation.SessionOptions{Model: "main"},
		fake.Reply{Text: "One."},
		fake.Reply{Text: "Two."},
		fake.Reply{Text: enginetest.StructuredSummary, Expect: modelIs("compactor")},
		fake.Reply{Text: "Three.", Expect: modelIs("main")},
	)
	r.Engine.ConfigureModels([]catalog.Override{{Provider: "fake", Window: new(32000)}})
	r.Engine.ConfigureAgents(registry.AgentSettings{Agents: map[string]config.Agent{"compaction": {Model: "fake/compactor"}}})
	r.Say("First question")
	r.Say("Second question")
	if err := r.Engine.CompactSession(r.Context, r.ID); err != nil {
		t.Fatal(err)
	}
	r.Say("Third question")
}

// extractNotesWith runs one conversation with automatic memory on and returns once its note was saved; the
// extraction request must ask for the model want.
func extractNotesWith(t *testing.T, want string, memorySettings conversation.MemorySettings, agents map[string]config.Agent) {
	t.Helper()
	ctx, cancel := context.WithTimeout(t.Context(), 20*time.Second)
	defer cancel()
	dir, durable := t.TempDir(), storage.New()
	provider := fake.New(t,
		fake.Reply{Text: "Answer.", Expect: modelIs("main")},
		fake.Reply{Text: `[{"kind":"fact","text":"The build uses pnpm","tags":[]}]`, Expect: modelIs(want)},
	)
	deps := enginetest.Deps(t)
	deps.Store = durable
	deps.Workdir = dir
	deps.MemoryIdle = 50 * time.Millisecond
	deps.Providers = map[string]model.Provider{"fake": provider}
	e, err := engine.New(deps)
	if err != nil {
		t.Fatal(err)
	}
	defer e.Close()
	e.ConfigureMemory(memorySettings)
	e.ConfigureAgents(registry.AgentSettings{Agents: agents})
	id, err := e.CreateSession(ctx, conversation.SessionOptions{Provider: "fake", Model: "main", Workdir: dir})
	if err != nil {
		t.Fatal(err)
	}
	if err := e.Send(ctx, id, []model.Part{{Text: "Hello"}}); err != nil {
		t.Fatal(err)
	}
	owner := memory.ProjectOwner(dir)
	enginetest.WaitFor(t, ctx, "the extracted note", func() bool {
		notes, _ := memory.New(durable).List(ctx, []memory.Owner{owner})
		return len(notes) == 1
	})
}

func TestTheMemoryExtractorAgentChoosesTheModelThatWritesNotes(t *testing.T) {
	extractNotesWith(t, "extractor", conversation.MemorySettings{AutoExtract: true}, map[string]config.Agent{"memory-extractor": {Model: "fake/extractor"}})
}

func TestTheMemoryModelSettingChoosesTheModelThatWritesNotesAndTheAgentEntryWinsOverIt(t *testing.T) {
	extractNotesWith(t, "memory-model", conversation.MemorySettings{AutoExtract: true, Model: "fake/memory-model"}, nil)
	extractNotesWith(t, "extractor", conversation.MemorySettings{AutoExtract: true, Model: "fake/memory-model"}, map[string]config.Agent{"memory-extractor": {Model: "fake/extractor"}})
}

func requestTools(req model.Request) []string {
	var names []string
	for _, spec := range req.Tools {
		names = append(names, spec.Name)
	}
	return names
}

func TestTheBuildAgentOverridesTheBuiltInWorkerOfANewConversation(t *testing.T) {
	ctx, cancel := context.WithTimeout(t.Context(), 20*time.Second)
	defer cancel()
	check := func(wantModel string) func(model.Request) error {
		return func(req model.Request) error {
			if req.Model != wantModel {
				return fmt.Errorf("model = %q, want %q", req.Model, wantModel)
			}
			if !strings.Contains(req.System, "Build carefully.") {
				return fmt.Errorf("the prompt of the build agent is missing from the system prompt")
			}
			names := requestTools(req)
			if slices.Contains(names, "bash") || !slices.Contains(names, "read_file") {
				return fmt.Errorf("tools = %v, want bash switched off and read_file kept", names)
			}
			return nil
		}
	}
	provider := fake.New(t,
		fake.Reply{Text: "One.", Expect: check("builder")},
		fake.Reply{Text: "Two.", Expect: check("chosen")},
	)
	deps2 := enginetest.Deps(t)
	deps2.Workdir = t.TempDir()
	deps2.Providers = map[string]model.Provider{"fake": provider}
	e, err := engine.New(deps2)
	if err != nil {
		t.Fatal(err)
	}
	defer e.Close()
	e.ConfigureAgents(registry.AgentSettings{Agents: map[string]config.Agent{"build": {Model: "fake/builder", Prompt: "Build carefully.", Tools: map[string]bool{"bash": false}}}})
	for _, options := range []conversation.SessionOptions{{}, {Provider: "fake", Model: "chosen"}} {
		options.Workdir = t.TempDir()
		id, err := e.CreateSession(ctx, options)
		if err != nil {
			t.Fatal(err)
		}
		turns, stop := e.Subscribe(event.Filter{Scope: event.Scope{Session: id}, Types: []event.Type{loop.TurnFinished}})
		if err := e.Send(ctx, id, []model.Part{{Text: "Hello"}}); err != nil {
			t.Fatal(err)
		}
		<-turns
		stop()
	}
}

// spawnRig answers the requests of a parent that spawns the named agents one after another and records the first
// request of each child, told apart by the marker in its system prompt.
type spawnRig struct {
	mu      sync.Mutex
	spawned int
	agents  []string
	markers []string
	seen    map[string]model.Request
}

func (s *spawnRig) answer(req model.Request) []model.Chunk {
	s.mu.Lock()
	defer s.mu.Unlock()
	for _, marker := range s.markers {
		if strings.Contains(req.System, marker) {
			if _, done := s.seen[marker]; !done {
				s.seen[marker] = req
			}
			return enginetest.Text("Reported.")
		}
	}
	if s.spawned < len(s.agents) {
		s.spawned++
		return enginetest.Call(fmt.Sprintf("spawn-%d", s.spawned), "spawn", map[string]any{"prompt": "Look around", "agent": s.agents[s.spawned-1]})
	}
	return enginetest.Text("Done.")
}

func (s *spawnRig) request(t *testing.T, marker string) model.Request {
	t.Helper()
	var found model.Request
	enginetest.WaitFor(t, t.Context(), "the child with "+marker, func() bool {
		s.mu.Lock()
		defer s.mu.Unlock()
		var ok bool
		found, ok = s.seen[marker]
		return ok
	})
	return found
}

func TestGeneralAndExploreCanBeSpawnedAndTheAgentSectionChangesThem(t *testing.T) {
	rig := &spawnRig{agents: []string{"explore", "general"}, markers: []string{"fast search agent", "Be thorough."}, seen: map[string]model.Request{}}
	deps3 := enginetest.Deps(t)
	deps3.Workdir = t.TempDir()
	deps3.Providers = map[string]model.Provider{"fake": &enginetest.Chooser{T: t, Answer: rig.answer}}
	e, err := engine.New(deps3)
	if err != nil {
		t.Fatal(err)
	}
	defer e.Close()
	e.ConfigureAgents(registry.AgentSettings{Agents: map[string]config.Agent{"general": {Model: "fake/general-model", Prompt: "Be thorough."}}})
	id, err := e.CreateSession(t.Context(), conversation.SessionOptions{Provider: "fake", Workdir: t.TempDir()})
	if err != nil {
		t.Fatal(err)
	}
	(&enginetest.ChatRig{T: t, Engine: e, Context: t.Context(), ID: id}).Say("Look around twice")
	if explore := rig.request(t, "fast search agent"); explore.Model == "general-model" {
		t.Fatalf("explore took the model of general: %q", explore.Model)
	}
	if general := rig.request(t, "Be thorough."); general.Model != "general-model" || strings.Contains(general.System, "fast search agent") {
		t.Fatalf("general ran model %q with the system prompt %q", general.Model, general.System)
	}
}

func TestAnyOtherNameInTheAgentSectionIsAnAgentOfItsOwn(t *testing.T) {
	rig := &spawnRig{agents: []string{"reviewer", "hidden"}, markers: []string{"Only review."}, seen: map[string]model.Request{}}
	deps4 := enginetest.Deps(t)
	deps4.Workdir = t.TempDir()
	deps4.Providers = map[string]model.Provider{"fake": &enginetest.Chooser{T: t, Answer: rig.answer}}
	e, err := engine.New(deps4)
	if err != nil {
		t.Fatal(err)
	}
	defer e.Close()
	e.ConfigureAgents(registry.AgentSettings{Agents: map[string]config.Agent{
		"reviewer": {Model: "fake/review-model", Prompt: "Only review.", Description: "Reviews", Tools: map[string]bool{"gre*": false}},
		"hidden":   {Prompt: "Never seen.", Disabled: true},
		"title":    {Model: "fake/tiny"},
	}})
	listed, err := e.ListAgentsFor(t.Context(), "owner", "")
	if err != nil {
		t.Fatal(err)
	}
	var names []string
	for _, a := range listed {
		if a.Source == "config" {
			names = append(names, a.Name+":"+a.Summary)
			if _, err := e.SaveAgent(t.Context(), "owner", a); err == nil {
				t.Fatalf("an agent of the configuration was saved: %s", a.Name)
			}
		}
	}
	if !slices.Equal(names, []string{"reviewer:Reviews"}) {
		t.Fatalf("agents of the configuration = %v", names)
	}
	id, err := e.CreateSession(t.Context(), conversation.SessionOptions{Provider: "fake", Workdir: t.TempDir()})
	if err != nil {
		t.Fatal(err)
	}
	(&enginetest.ChatRig{T: t, Engine: e, Context: t.Context(), ID: id}).Say("Review it")
	seen := rig.request(t, "Only review.")
	if seen.Model != "review-model" {
		t.Fatalf("the child ran model %q", seen.Model)
	}
	if names := requestTools(seen); slices.Contains(names, "grep") || !slices.Contains(names, "read_file") {
		t.Fatalf("the child was offered %v", names)
	}
	rig.mu.Lock()
	defer rig.mu.Unlock()
	if len(rig.seen) != 1 {
		t.Fatalf("a disabled agent was started: %v", rig.seen)
	}
}

func TestDefaultAgentIsTheAgentANewConversationStartsWith(t *testing.T) {
	ctx, cancel := context.WithTimeout(t.Context(), 20*time.Second)
	defer cancel()
	project := t.TempDir()
	if err := os.MkdirAll(filepath.Join(project, ".merakcode", "agents"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(project, ".merakcode", "agents", "scribe.md"), []byte("---\nmodel: fake/scribe-model\n---\nWrite it down."), 0o600); err != nil {
		t.Fatal(err)
	}
	expect := func(wantModel, wantPrompt string) fake.Reply {
		return fake.Reply{Text: "Hi.", Expect: func(req model.Request) error {
			if req.Model != wantModel || !strings.Contains(req.System, wantPrompt) {
				return fmt.Errorf("model = %q, want %q, and the system prompt must contain %q", req.Model, wantModel, wantPrompt)
			}
			return nil
		}}
	}
	provider := fake.New(t,
		expect("review-model", "Only review."),
		expect("scribe-model", "Write it down."),
		expect("chosen", "Only review."),
	)
	deps5 := enginetest.Deps(t)
	deps5.Workdir = project
	deps5.Providers = map[string]model.Provider{"fake": provider}
	e, err := engine.New(deps5)
	if err != nil {
		t.Fatal(err)
	}
	defer e.Close()
	agents := map[string]config.Agent{"reviewer": {Model: "fake/review-model", Prompt: "Only review."}}
	run := func(options conversation.SessionOptions) {
		t.Helper()
		options.Workdir = project
		id, err := e.CreateSession(ctx, options)
		if err != nil {
			t.Fatal(err)
		}
		turns, stop := e.Subscribe(event.Filter{Scope: event.Scope{Session: id}, Types: []event.Type{loop.TurnFinished}})
		defer stop()
		if err := e.Send(ctx, id, []model.Part{{Text: "Hello"}}); err != nil {
			t.Fatal(err)
		}
		<-turns
	}
	e.ConfigureAgents(registry.AgentSettings{Agents: agents, Default: "reviewer"})
	run(conversation.SessionOptions{})
	e.ConfigureAgents(registry.AgentSettings{Agents: agents, Default: "scribe"})
	run(conversation.SessionOptions{})
	e.ConfigureAgents(registry.AgentSettings{Agents: agents, Default: "reviewer"})
	run(conversation.SessionOptions{Provider: "fake", Model: "chosen"})
}
