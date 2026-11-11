package engine_test

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
	"github.com/TongTong313/merakcode/merak/engine/event"
	"github.com/TongTong313/merakcode/merak/engine/loop"
	"github.com/TongTong313/merakcode/merak/engine/memory"
	"github.com/TongTong313/merakcode/merak/engine/model"
	"github.com/TongTong313/merakcode/merak/engine/model/catalog"
	"github.com/TongTong313/merakcode/merak/engine/model/fake"
	storage "github.com/TongTong313/merakcode/merak/engine/store/memory"
	"github.com/TongTong313/merakcode/merak/internal/platform/config"
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
	r := newChatRig(t, engine.SessionOptions{Model: "main"},
		fake.Reply{Text: "Hello there.", Expect: modelIs("main")},
		fake.Reply{Text: "Release plan", Expect: modelIs("titler")},
	)
	r.e.ConfigureAgents(engine.AgentSettings{Agents: map[string]config.Agent{"title": {Model: "fake/titler"}}})
	r.say("Help me plan the release")
	waitFor(t, r.ctx, "the title", func() bool { return r.state().Title == "Release plan" })
}

func TestTheSummaryAgentChoosesTheModelThatWritesACommitMessage(t *testing.T) {
	e, repo, ctx := codeEngine(t, fake.Reply{Text: "Rewrite the greeting", Expect: modelIs("summarizer")})
	e.SetDefaultModel("fake", "writer", "")
	e.ConfigureAgents(engine.AgentSettings{Agents: map[string]config.Agent{"summary": {Model: "fake/summarizer"}}})
	if err := os.WriteFile(filepath.Join(repo, "README.md"), []byte("Changed\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	message, err := e.RepoCommitMessage(ctx, repo)
	if err != nil || message != "Rewrite the greeting" {
		t.Fatalf("message=%q err=%v", message, err)
	}
}

func TestTheCompactionAgentChoosesTheModelThatSummarizesAConversation(t *testing.T) {
	r := newChatRig(t, engine.SessionOptions{Model: "main"},
		fake.Reply{Text: "One."},
		fake.Reply{Text: "Two."},
		fake.Reply{Text: structuredSummary, Expect: modelIs("compactor")},
		fake.Reply{Text: "Three.", Expect: modelIs("main")},
	)
	r.e.ConfigureModels([]catalog.Override{{Provider: "fake", Window: new(32000)}})
	r.e.ConfigureAgents(engine.AgentSettings{Agents: map[string]config.Agent{"compaction": {Model: "fake/compactor"}}})
	r.say("First question")
	r.say("Second question")
	if err := r.e.CompactSession(r.ctx, r.id); err != nil {
		t.Fatal(err)
	}
	r.say("Third question")
}

// extractNotesWith runs one conversation with automatic memory on and returns once its note was saved; the
// extraction request must ask for the model want.
func extractNotesWith(t *testing.T, want string, memorySettings engine.MemorySettings, agents map[string]config.Agent) {
	t.Helper()
	ctx, cancel := context.WithTimeout(t.Context(), 20*time.Second)
	defer cancel()
	dir, durable := t.TempDir(), storage.New()
	provider := fake.New(t,
		fake.Reply{Text: "Answer.", Expect: modelIs("main")},
		fake.Reply{Text: `[{"kind":"fact","text":"The build uses pnpm","tags":[]}]`, Expect: modelIs(want)},
	)
	e, err := engine.New(engine.Deps{Store: durable, Workdir: dir, MemoryIdle: 50 * time.Millisecond, Providers: map[string]model.Provider{"fake": provider}})
	if err != nil {
		t.Fatal(err)
	}
	defer e.Close()
	e.ConfigureMemory(memorySettings)
	e.ConfigureAgents(engine.AgentSettings{Agents: agents})
	id, err := e.CreateSession(ctx, engine.SessionOptions{Provider: "fake", Model: "main", Workdir: dir})
	if err != nil {
		t.Fatal(err)
	}
	if err := e.Send(ctx, id, []model.Part{{Text: "Hello"}}); err != nil {
		t.Fatal(err)
	}
	owner := memory.ProjectOwner(dir)
	waitFor(t, ctx, "the extracted note", func() bool {
		notes, _ := memory.New(durable).List(ctx, []memory.Owner{owner})
		return len(notes) == 1
	})
}

func TestTheMemoryExtractorAgentChoosesTheModelThatWritesNotes(t *testing.T) {
	extractNotesWith(t, "extractor", engine.MemorySettings{AutoExtract: true}, map[string]config.Agent{"memory-extractor": {Model: "fake/extractor"}})
}

func TestTheMemoryModelSettingChoosesTheModelThatWritesNotesAndTheAgentEntryWinsOverIt(t *testing.T) {
	extractNotesWith(t, "memory-model", engine.MemorySettings{AutoExtract: true, Model: "fake/memory-model"}, nil)
	extractNotesWith(t, "extractor", engine.MemorySettings{AutoExtract: true, Model: "fake/memory-model"}, map[string]config.Agent{"memory-extractor": {Model: "fake/extractor"}})
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
	e, err := engine.New(engine.Deps{Workdir: t.TempDir(), Providers: map[string]model.Provider{"fake": provider}})
	if err != nil {
		t.Fatal(err)
	}
	defer e.Close()
	e.ConfigureAgents(engine.AgentSettings{Agents: map[string]config.Agent{"build": {Model: "fake/builder", Prompt: "Build carefully.", Tools: map[string]bool{"bash": false}}}})
	for _, options := range []engine.SessionOptions{{}, {Provider: "fake", Model: "chosen"}} {
		options.Workdir = t.TempDir()
		id, err := e.CreateSession(ctx, options)
		if err != nil {
			t.Fatal(err)
		}
		turns, stop := e.Bus.Subscribe(event.Filter{Scope: event.Scope{Session: id}, Types: []event.Type{loop.TurnFinished}})
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
			return text("Reported.")
		}
	}
	if s.spawned < len(s.agents) {
		s.spawned++
		return call(fmt.Sprintf("spawn-%d", s.spawned), "spawn", map[string]any{"prompt": "Look around", "agent": s.agents[s.spawned-1]})
	}
	return text("Done.")
}

func (s *spawnRig) request(t *testing.T, marker string) model.Request {
	t.Helper()
	var found model.Request
	waitFor(t, t.Context(), "the child with "+marker, func() bool {
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
	e, err := engine.New(engine.Deps{Workdir: t.TempDir(), Providers: map[string]model.Provider{"fake": &chooser{t: t, answer: rig.answer}}})
	if err != nil {
		t.Fatal(err)
	}
	defer e.Close()
	e.ConfigureAgents(engine.AgentSettings{Agents: map[string]config.Agent{"general": {Model: "fake/general-model", Prompt: "Be thorough."}}})
	id, err := e.CreateSession(t.Context(), engine.SessionOptions{Provider: "fake", Workdir: t.TempDir()})
	if err != nil {
		t.Fatal(err)
	}
	(&chatRig{t: t, e: e, ctx: t.Context(), id: id}).say("Look around twice")
	if explore := rig.request(t, "fast search agent"); explore.Model == "general-model" {
		t.Fatalf("explore took the model of general: %q", explore.Model)
	}
	if general := rig.request(t, "Be thorough."); general.Model != "general-model" || strings.Contains(general.System, "fast search agent") {
		t.Fatalf("general ran model %q with the system prompt %q", general.Model, general.System)
	}
}

func TestAnyOtherNameInTheAgentSectionIsAnAgentOfItsOwn(t *testing.T) {
	rig := &spawnRig{agents: []string{"reviewer", "hidden"}, markers: []string{"Only review."}, seen: map[string]model.Request{}}
	e, err := engine.New(engine.Deps{Workdir: t.TempDir(), Providers: map[string]model.Provider{"fake": &chooser{t: t, answer: rig.answer}}})
	if err != nil {
		t.Fatal(err)
	}
	defer e.Close()
	e.ConfigureAgents(engine.AgentSettings{Agents: map[string]config.Agent{
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
	id, err := e.CreateSession(t.Context(), engine.SessionOptions{Provider: "fake", Workdir: t.TempDir()})
	if err != nil {
		t.Fatal(err)
	}
	(&chatRig{t: t, e: e, ctx: t.Context(), id: id}).say("Review it")
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
	e, err := engine.New(engine.Deps{Workdir: project, Providers: map[string]model.Provider{"fake": provider}})
	if err != nil {
		t.Fatal(err)
	}
	defer e.Close()
	agents := map[string]config.Agent{"reviewer": {Model: "fake/review-model", Prompt: "Only review."}}
	run := func(options engine.SessionOptions) {
		t.Helper()
		options.Workdir = project
		id, err := e.CreateSession(ctx, options)
		if err != nil {
			t.Fatal(err)
		}
		turns, stop := e.Bus.Subscribe(event.Filter{Scope: event.Scope{Session: id}, Types: []event.Type{loop.TurnFinished}})
		defer stop()
		if err := e.Send(ctx, id, []model.Part{{Text: "Hello"}}); err != nil {
			t.Fatal(err)
		}
		<-turns
	}
	e.ConfigureAgents(engine.AgentSettings{Agents: agents, Default: "reviewer"})
	run(engine.SessionOptions{})
	e.ConfigureAgents(engine.AgentSettings{Agents: agents, Default: "scribe"})
	run(engine.SessionOptions{})
	e.ConfigureAgents(engine.AgentSettings{Agents: agents, Default: "reviewer"})
	run(engine.SessionOptions{Provider: "fake", Model: "chosen"})
}
