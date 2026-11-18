package conversation_test

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
	"unicode/utf8"

	"github.com/TongTong313/merakcode/merak/engine"
	"github.com/TongTong313/merakcode/merak/engine/agent/conversation"
	"github.com/TongTong313/merakcode/merak/engine/agent/definition"
	"github.com/TongTong313/merakcode/merak/engine/agent/loop"
	"github.com/TongTong313/merakcode/merak/engine/agent/model"
	"github.com/TongTong313/merakcode/merak/engine/agent/model/catalog"
	"github.com/TongTong313/merakcode/merak/engine/agent/model/fake"
	"github.com/TongTong313/merakcode/merak/engine/agent/permission"
	"github.com/TongTong313/merakcode/merak/engine/agent/session"
	"github.com/TongTong313/merakcode/merak/engine/agent/window"
	"github.com/TongTong313/merakcode/merak/engine/feature/sessions"
	"github.com/TongTong313/merakcode/merak/engine/infra/errorcode"
	"github.com/TongTong313/merakcode/merak/engine/infra/event"
	"github.com/TongTong313/merakcode/merak/engine/infra/process"
	"github.com/TongTong313/merakcode/merak/engine/infra/store"
	"github.com/TongTong313/merakcode/merak/testkit/enginetest"
)

func TestASessionCanBeRenamedAndArchivedAndItsListIsDurable(t *testing.T) {
	r := enginetest.NewChatRig(t, conversation.SessionOptions{}, fake.Reply{Text: "Hello."})
	r.Say("Hi")
	title, archived := "Fix the login", true
	if err := r.Engine.UpdateSession(r.Context, r.ID, session.Update{Title: &title}); err != nil {
		t.Fatal(err)
	}
	if err := r.Engine.UpdateSession(r.Context, r.ID, session.Update{Archived: &archived}); err != nil {
		t.Fatal(err)
	}
	list, err := r.Engine.ListSessions(r.Context)
	if err != nil || len(list) != 1 || list[0].Title != title || !list[0].Archived {
		t.Fatalf("list=%+v err=%v", list, err)
	}
	if state := r.State(); state.Title != title || !state.Archived {
		t.Fatalf("snapshot title=%q archived=%v", state.Title, state.Archived)
	}
	archived = false
	if err := r.Engine.UpdateSession(r.Context, r.ID, session.Update{Archived: &archived}); err != nil {
		t.Fatal(err)
	}
	if list, _ = r.Engine.ListSessions(r.Context); list[0].Archived || list[0].Title != title {
		t.Fatalf("restoring lost something: %+v", list[0])
	}
}

func TestTakeoverModeNeedsConfirmationAndAppliesToTheNextTurn(t *testing.T) {
	r := enginetest.NewChatRig(t, conversation.SessionOptions{Mode: permission.ModeAsk},
		enginetest.IntegrationCall("write_file", map[string]any{"path": "taken.txt", "content": "over"}),
		fake.Reply{Text: "Done."},
	)
	err := r.Engine.UpdateSession(r.Context, r.ID, session.Update{Mode: permission.ModeTakeover})
	if err == nil {
		t.Fatal("takeover was accepted without confirmation")
	}
	if err := r.Engine.UpdateSession(r.Context, r.ID, session.Update{Mode: permission.ModeTakeover, Confirm: true}); err != nil {
		t.Fatal(err)
	}
	r.Say("Write it")
	if body, ok := r.File("taken.txt"); !ok || body != "over" {
		t.Fatalf("the takeover turn did not write: %q %v", body, ok)
	}
	if r.State().Config.Mode != permission.ModeTakeover {
		t.Fatal("the mode is not kept")
	}
}

func hasText(messages []model.Message, text string) bool {
	for _, message := range messages {
		for _, part := range message.Parts {
			if part.Text == text {
				return true
			}
		}
	}
	return false
}

func TestRevertingToAMessageHidesItAndPutsFilesBackAndUnrevertBringsThemAll(t *testing.T) {
	r := enginetest.NewChatRig(t, conversation.SessionOptions{Mode: permission.ModeTakeover},
		enginetest.IntegrationCall("write_file", map[string]any{"path": "first.txt", "content": "kept"}),
		fake.Reply{Text: "First done."},
		enginetest.IntegrationCall("write_file", map[string]any{"path": "made.txt", "content": "second turn"}),
		fake.Reply{Text: "Second done."},
	)
	r.Say("First question")
	second := r.Say("Second question")
	if _, ok := r.File("made.txt"); !ok {
		t.Fatal("the fixture did not write")
	}
	if err := r.Engine.RevertSession(r.Context, r.ID, second); err != nil {
		t.Fatal(err)
	}
	if _, ok := r.File("made.txt"); ok {
		t.Fatal("the file of the reverted turn is still there")
	}
	if body, ok := r.File("first.txt"); !ok || body != "kept" {
		t.Fatalf("the first turn lost its file: %q %v", body, ok)
	}
	state := r.State()
	if hasText(state.Messages, "Second question") || !hasText(state.Messages, "First question") {
		t.Fatalf("messages after the revert: %+v", state.Messages)
	}
	if err := r.Engine.UnrevertSession(r.Context, r.ID); err != nil {
		t.Fatal(err)
	}
	if body, ok := r.File("made.txt"); !ok || body != "second turn" {
		t.Fatalf("unrevert lost the file: %q %v", body, ok)
	}
	if state := r.State(); !hasText(state.Messages, "Second question") {
		t.Fatal("unrevert did not bring the messages back")
	}
}

func TestRevertCoversWhatBashAndEditFileChangedByteForByte(t *testing.T) {
	r := enginetest.NewChatRig(t, conversation.SessionOptions{Mode: permission.ModeTakeover},
		enginetest.IntegrationCall("bash", map[string]any{"command": "printf 'bash made' > made.txt && printf 'changed' > existing.txt"}),
		enginetest.IntegrationCall("read_file", map[string]any{"path": "crlf.txt"}),
		enginetest.IntegrationCall("edit_file", map[string]any{"path": "crlf.txt", "oldText": "alpha", "newText": "omega"}),
		fake.Reply{Text: "Done."},
	)
	if err := os.WriteFile(filepath.Join(r.Directory, "existing.txt"), []byte("original"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(r.Directory, "crlf.txt"), []byte("alpha\r\nbeta\r\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	turn := r.Say("Change things")
	if body, _ := r.File("crlf.txt"); body != "omega\r\nbeta\r\n" {
		t.Fatalf("edit_file did not edit: %q", body)
	}
	if err := r.Engine.RevertSession(r.Context, r.ID, turn); err != nil {
		t.Fatal(err)
	}
	if _, ok := r.File("made.txt"); ok {
		t.Fatal("the file bash made survived")
	}
	if body, _ := r.File("existing.txt"); body != "original" {
		t.Fatalf("existing.txt = %q", body)
	}
	if body, _ := r.File("crlf.txt"); body != "alpha\r\nbeta\r\n" {
		t.Fatalf("crlf.txt = %q", body)
	}
	if err := r.Engine.UnrevertSession(r.Context, r.ID); err != nil {
		t.Fatal(err)
	}
	if body, _ := r.File("made.txt"); body != "bash made" {
		t.Fatalf("made.txt = %q", body)
	}
	if body, _ := r.File("existing.txt"); body != "changed" {
		t.Fatalf("existing.txt = %q", body)
	}
}

func TestAfterARevertTheModelNeverSeesTheHiddenTurnAndTheRevertCannotBeUndone(t *testing.T) {
	var seen [][]model.Message
	record := func(req model.Request) error { seen = append(seen, req.Messages); return nil }
	r := enginetest.NewChatRig(t, conversation.SessionOptions{},
		fake.Reply{Text: "One.", Expect: record},
		fake.Reply{Text: "Two.", Expect: record},
		fake.Reply{Text: "Three.", Expect: record},
	)
	r.Say("First question")
	second := r.Say("Second question")
	if err := r.Engine.RevertSession(r.Context, r.ID, second); err != nil {
		t.Fatal(err)
	}
	r.Say("Replacement question")
	last := seen[len(seen)-1]
	if hasText(last, "Second question") || hasText(last, "Two.") || !hasText(last, "Replacement question") || !hasText(last, "First question") {
		t.Fatalf("the model saw %+v", last)
	}
	err := r.Engine.UnrevertSession(r.Context, r.ID)
	var coded *errorcode.Error
	if !errors.As(err, &coded) || coded.Code != "MRK-4008" {
		t.Fatalf("unrevert after a new message: %v", err)
	}
	if err := r.Engine.RevertSession(r.Context, r.ID, "not-a-message"); !errors.As(err, &coded) || coded.Code != "MRK-4007" {
		t.Fatalf("reverting to a stranger: %v", err)
	}
}

func TestCompactingByHandRebuildsTheContextAtOnceAndTheNextTurnStartsWithTheSummary(t *testing.T) {
	var last []model.Message
	r := enginetest.NewChatRig(t, conversation.SessionOptions{},
		fake.Reply{Text: "One."},
		fake.Reply{Text: "Two."},
		fake.Reply{Text: enginetest.StructuredSummary},
		fake.Reply{Text: "Three.", Expect: func(req model.Request) error { last = req.Messages; return nil }},
	)
	r.Engine.ConfigureModels([]catalog.Override{{Provider: "fake", Window: new(32000)}})
	r.Say("First question")
	r.Say("Second question")
	facts, stop := r.Engine.Subscribe(event.Filter{Scope: event.Scope{Session: r.ID}, Types: []event.Type{session.Rebuilt}})
	defer stop()
	if err := r.Engine.CompactSession(r.Context, r.ID); err != nil {
		t.Fatal(err)
	}
	select {
	case <-facts:
	case <-r.Context.Done():
		t.Fatal("no context rebuild event")
	}
	r.Say("Third question")
	if len(last) == 0 || last[0].Parts[0].Text != enginetest.StructuredSummary || hasText(last, "First question") || !hasText(last, "Third question") {
		t.Fatalf("the next turn started with %+v", last)
	}
}

func TestWithAutomaticCompactionOffAFullContextFailsWithItsOwnCode(t *testing.T) {
	replies := make([]fake.Reply, 12)
	for i := range replies {
		replies[i] = fake.Reply{Text: "Noted."}
	}
	r := enginetest.NewChatRig(t, conversation.SessionOptions{}, replies...)
	r.Engine.ConfigureModels([]catalog.Override{{Provider: "fake", Window: new(40000), MaxOutput: new(4000)}})
	r.Engine.ConfigureSessions(sessions.SessionSettings{Snapshot: true, AutoCompact: false})
	facts, stop := r.Engine.Subscribe(event.Filter{Scope: event.Scope{Session: r.ID}, Types: []event.Type{window.BudgetReported, loop.TurnFinished}})
	defer stop()
	for range 10 {
		if err := r.Engine.Send(r.Context, r.ID, []model.Part{{Text: strings.Repeat("filler ", 5000)}}); err != nil {
			t.Fatal(err)
		}
		for finished := false; !finished; {
			select {
			case fact := <-facts:
				if fact.Type == loop.TurnFinished {
					finished = true
					break
				}
				if report, err := event.Decode[window.Report](fact); err == nil && report.Code != "" {
					if report.Code != "MRK-4010" {
						t.Fatalf("code=%s", report.Code)
					}
					return
				}
			case <-r.Context.Done():
				t.Fatal("the full context was never reported")
			}
		}
	}
	t.Fatal("the context never filled up")
}

func TestWithSnapshotsOffARevertOnlyHidesMessages(t *testing.T) {
	r := enginetest.NewChatRig(t, conversation.SessionOptions{Mode: permission.ModeTakeover},
		enginetest.IntegrationCall("write_file", map[string]any{"path": "stays.txt", "content": "still here"}),
		fake.Reply{Text: "Done."},
	)
	r.Engine.ConfigureSessions(sessions.SessionSettings{Snapshot: false, AutoCompact: true})
	turn := r.Say("Write it")
	if err := r.Engine.RevertSession(r.Context, r.ID, turn); err != nil {
		t.Fatal(err)
	}
	if body, ok := r.File("stays.txt"); !ok || body != "still here" {
		t.Fatalf("a revert without snapshots touched the files: %q %v", body, ok)
	}
	if hasText(r.State().Messages, "Write it") {
		t.Fatal("the message was not hidden")
	}
}

func TestSearchFindsASessionByAWordOfAnyMessageAndShowsWhereItWas(t *testing.T) {
	r := enginetest.NewChatRig(t, conversation.SessionOptions{}, fake.Reply{Text: "Noted."}, fake.Reply{Text: "The pineapple answer."})
	r.Say("Let us plan the release")
	r.Say("Second message about Pineapple pizza and nothing else at all that matters here today")
	title := "Release planning"
	if err := r.Engine.UpdateSession(r.Context, r.ID, session.Update{Title: &title}); err != nil {
		t.Fatal(err)
	}
	hits, err := r.Engine.SearchSessions(r.Context, "pineapple", 10)
	if err != nil || len(hits) != 1 {
		t.Fatalf("hits=%+v err=%v", hits, err)
	}
	if hits[0].Session != r.ID || hits[0].Title != title || !strings.Contains(strings.ToLower(hits[0].Snippet), "pineapple") || len(hits[0].Snippet) > 160 {
		t.Fatalf("hit=%+v", hits[0])
	}
	if hits, _ = r.Engine.SearchSessions(r.Context, "no such word", 10); len(hits) != 0 {
		t.Fatalf("a missing word found %+v", hits)
	}
	if hits, _ = r.Engine.SearchSessions(r.Context, "e", 1); len(hits) != 1 {
		t.Fatalf("limit ignored: %+v", hits)
	}
}

func TestDeletingASessionRemovesItForGoodAndItsFilesSnapshot(t *testing.T) {
	r := enginetest.NewChatRig(t, conversation.SessionOptions{Mode: permission.ModeTakeover},
		enginetest.IntegrationCall("write_file", map[string]any{"path": "made.txt", "content": "x"}),
		fake.Reply{Text: "Done."},
	)
	r.Say("Write it")
	kept := newChatRigOn(t, r.Engine, conversation.SessionOptions{})
	if err := r.Engine.DeleteSession(r.Context, r.ID); err != nil {
		t.Fatal(err)
	}
	list, err := r.Engine.ListSessions(r.Context)
	if err != nil || len(list) != 1 || list[0].ID != kept {
		t.Fatalf("list=%+v err=%v", list, err)
	}
	if _, err := r.Engine.SessionSnapshot(r.Context, r.ID); err == nil {
		t.Fatal("a deleted session still has a snapshot")
	}
	if facts, err := r.Engine.FindEvents(r.Context, store.Query{Scope: event.Scope{Session: r.ID}}); err != nil || len(facts) != 0 {
		t.Fatalf("events left behind: %d %v", len(facts), err)
	}
	if err := r.Engine.Send(r.Context, r.ID, []model.Part{{Text: "Hello?"}}); err == nil {
		t.Fatal("a deleted session accepted a message")
	}
	if _, ok := r.File("made.txt"); !ok {
		t.Fatal("deleting the conversation must not touch the project's files")
	}
}

// newChatRigOn adds a second conversation to an engine and returns its id.
func newChatRigOn(t *testing.T, e *engine.Engine, options conversation.SessionOptions) event.ID {
	t.Helper()
	options.Provider, options.Workdir = "fake", t.TempDir()
	id, err := e.CreateSession(t.Context(), options)
	if err != nil {
		t.Fatal(err)
	}
	return id
}

func TestTheFirstAnswerGetsATitleFromTheSmallModelAndAUsersNameWins(t *testing.T) {
	t.Run("generated", func(t *testing.T) {
		r := enginetest.NewChatRig(t, conversation.SessionOptions{}, fake.Reply{Text: "Hello there."}, fake.Reply{Text: "\"Plan the release of the new login page for every platform we support today\"\nextra line"})
		r.Engine.SetSmallModel("fake", "tiny")
		r.Say("Help me plan the release")
		enginetest.WaitFor(t, r.Context, "the title", func() bool { return r.State().Title != "" })
		title := r.State().Title
		if utf8.RuneCountInString(title) > 50 || strings.ContainsAny(title, "\"\n") || !strings.HasPrefix(title, "Plan the release") {
			t.Fatalf("title=%q", title)
		}
	})
	t.Run("a title the user set while it was being written stays", func(t *testing.T) {
		gate := make(chan struct{})
		r := enginetest.NewChatRig(t, conversation.SessionOptions{}, fake.Reply{Text: "Hello there."}, fake.Reply{Text: "Generated title", Hold: gate})
		r.Engine.SetSmallModel("fake", "tiny")
		r.Say("Help me plan the release")
		mine := "My own name"
		if err := r.Engine.UpdateSession(r.Context, r.ID, session.Update{Title: &mine}); err != nil {
			t.Fatal(err)
		}
		close(gate)
		time.Sleep(300 * time.Millisecond)
		if title := r.State().Title; title != mine {
			t.Fatalf("title=%q", title)
		}
	})
	t.Run("without a small or default model no request is made", func(t *testing.T) {
		r := enginetest.NewChatRig(t, conversation.SessionOptions{}, fake.Reply{Text: "Hello there."})
		r.Say("Help me plan the release")
		time.Sleep(200 * time.Millisecond) // an extra request would exhaust the script and fail the test
		if title := r.State().Title; title != "" {
			t.Fatalf("title=%q", title)
		}
	})
}

func TestRetentionDeletesOnlyConversationsIdleForTooLong(t *testing.T) {
	ctx, cancel := context.WithTimeout(t.Context(), 20*time.Second)
	defer cancel()
	var mu sync.Mutex
	clock := time.Date(2026, 1, 1, 9, 0, 0, 0, time.UTC)
	now := func() time.Time { mu.Lock(); defer mu.Unlock(); return clock }
	advance := func(d time.Duration) { mu.Lock(); clock = clock.Add(d); mu.Unlock() }
	deps2 := enginetest.Deps(t)
	deps2.Workdir = t.TempDir()
	deps2.Now = now
	deps2.Providers = map[string]model.Provider{"fake": fake.New(t, fake.Reply{Text: "Old."}, fake.Reply{Text: "Recent."}, fake.Reply{Text: "Again."})}
	e, err := engine.New(deps2)
	if err != nil {
		t.Fatal(err)
	}
	defer e.Close()
	make := func() *enginetest.ChatRig {
		id, err := e.CreateSession(ctx, conversation.SessionOptions{Provider: "fake", Workdir: t.TempDir()})
		if err != nil {
			t.Fatal(err)
		}
		return &enginetest.ChatRig{T: t, Engine: e, Context: ctx, ID: id}
	}
	old, recent := make(), make()
	old.Say("An old question")
	advance(40 * 24 * time.Hour)
	recent.Say("A recent question")
	e.ConfigureSessions(sessions.SessionSettings{Snapshot: true, AutoCompact: true})
	if n, err := e.PruneSessions(ctx); err != nil || n != 0 {
		t.Fatalf("retention off removed %d: %v", n, err)
	}
	e.ConfigureSessions(sessions.SessionSettings{Snapshot: true, AutoCompact: true, RetentionDays: 30})
	if n, err := e.PruneSessions(ctx); err != nil || n != 1 {
		t.Fatalf("removed %d: %v", n, err)
	}
	list, err := e.ListSessions(ctx)
	if err != nil || len(list) != 1 || list[0].ID != recent.ID {
		t.Fatalf("list=%+v err=%v", list, err)
	}
}

func TestAConversationWithAnExternalAgentKeepsBothAnswersInOneStream(t *testing.T) {
	ctx, cancel := context.WithTimeout(t.Context(), 40*time.Second)
	defer cancel()
	bin := filepath.Join(t.TempDir(), "claude.exe")
	if out, err := process.Command(ctx, "", "go", "build", "-o", bin, "github.com/TongTong313/merakcode/merak/engine/collab/worker/claudecode/testdata/fakeclaude").CombinedOutput(); err != nil {
		t.Fatalf("build: %s %v", out, err)
	}
	dir := t.TempDir()
	deps3 := enginetest.Deps(t)
	deps3.Workdir = dir
	e, err := engine.New(deps3)
	if err != nil {
		t.Fatal(err)
	}
	defer e.Close()
	external := definition.DefaultMerakCode()
	external.Name, external.Mode = "Claude", permission.ModeTakeover
	external.Product = &definition.Product{Kind: definition.KindClaudeCode, Binary: bin}
	saved, err := e.SaveAgent(ctx, "owner", external)
	if err != nil {
		t.Fatal(err)
	}
	id, err := e.CreateSession(ctx, conversation.SessionOptions{Agent: saved.ID, Workdir: dir})
	if err != nil {
		t.Fatal(err)
	}
	answers := func() int {
		facts, err := e.FindEvents(ctx, store.Query{Scope: event.Scope{Session: id}, Types: []event.Type{session.MessageCompleted}})
		if err != nil {
			t.Fatal(err)
		}
		return len(facts)
	}
	for turn, text := range []string{"First message", "Second message"} {
		if err := e.Send(ctx, id, []model.Part{{Text: text}}); err != nil {
			t.Fatal(err)
		}
		enginetest.WaitFor(t, ctx, "answer "+text, func() bool { return answers() > turn })
	}
	created, err := e.FindEvents(ctx, store.Query{Scope: event.Scope{Session: id}, Types: []event.Type{session.Created}})
	if err != nil || len(created) != 1 {
		t.Fatalf("created=%d err=%v", len(created), err)
	}
	sent, err := e.FindEvents(ctx, store.Query{Scope: event.Scope{Session: id}, Types: []event.Type{session.MessageSent}})
	if err != nil || len(sent) < 2 {
		t.Fatalf("messages sent=%d err=%v", len(sent), err)
	}
	if list, err := e.ListSessions(ctx); err != nil || len(list) != 1 || list[0].ID != id {
		t.Fatalf("list=%+v err=%v", list, err)
	}
}

func TestSwitchingProviderInASessionKeepsItsSystemPrompt(t *testing.T) {
	ctx, cancel := context.WithTimeout(t.Context(), 20*time.Second)
	defer cancel()
	var systems []string
	record := func(req model.Request) error { systems = append(systems, req.System); return nil }
	dir := t.TempDir()
	deps4 := enginetest.Deps(t)
	deps4.Workdir = dir
	deps4.Providers = map[string]model.Provider{
		"first":  fake.New(t, fake.Reply{Text: "One.", Expect: record}),
		"second": fake.New(t, fake.Reply{Text: "Two.", Expect: record}),
	}
	e, err := engine.New(deps4)
	if err != nil {
		t.Fatal(err)
	}
	defer e.Close()
	id, err := e.CreateSession(ctx, conversation.SessionOptions{Provider: "first", Workdir: dir})
	if err != nil {
		t.Fatal(err)
	}
	r := &enginetest.ChatRig{T: t, Engine: e, Context: ctx, Directory: dir, ID: id}
	r.Say("One")
	facts, stop := e.Subscribe(event.Filter{Scope: event.Scope{Session: id}, Types: []event.Type{loop.TurnFinished}})
	defer stop()
	if err := e.Send(ctx, id, []model.Part{{Text: "Two"}}, session.Selection{Provider: "second", Model: "other"}); err != nil {
		t.Fatal(err)
	}
	select {
	case <-facts:
	case <-ctx.Done():
		t.Fatal("the second turn did not finish")
	}
	if len(systems) != 2 || systems[0] == "" || systems[0] != systems[1] || !strings.Contains(systems[0], "## Using your tools") {
		t.Fatalf("system prompts: %d, equal=%v", len(systems), len(systems) == 2 && systems[0] == systems[1])
	}
}

func TestAnExportedSessionImportsAsANewOneWithTheSameContent(t *testing.T) {
	r := enginetest.NewChatRig(t, conversation.SessionOptions{Mode: permission.ModeTakeover},
		enginetest.IntegrationCall("write_file", map[string]any{"path": "made.txt", "content": "x"}),
		fake.Reply{Text: "First done."},
		fake.Reply{Text: "Second done."},
	)
	r.Say("First question")
	second := r.Say("Second question")
	title := "Exported"
	if err := r.Engine.UpdateSession(r.Context, r.ID, session.Update{Title: &title}); err != nil {
		t.Fatal(err)
	}
	if err := r.Engine.RevertSession(r.Context, r.ID, second); err != nil {
		t.Fatal(err)
	}
	exported, err := r.Engine.ExportSession(r.Context, r.ID)
	if err != nil || len(exported) < 8 {
		t.Fatalf("exported %d events, %v", len(exported), err)
	}
	body, err := json.Marshal(exported)
	if err != nil {
		t.Fatal(err)
	}
	var again []event.Event
	if err := json.Unmarshal(body, &again); err != nil {
		t.Fatal(err)
	}
	imported, err := r.Engine.ImportSession(r.Context, again)
	if err != nil || imported == r.ID {
		t.Fatalf("imported=%q err=%v", imported, err)
	}
	original, copied := r.State(), session.State{}
	if copied, err = r.Engine.SessionSnapshot(r.Context, imported); err != nil {
		t.Fatal(err)
	}
	copiedMessages, _ := json.Marshal(copied.Messages)
	originalMessages, _ := json.Marshal(original.Messages)
	if copied.ID != imported || copied.Title != title || copied.Usage != original.Usage || string(copiedMessages) != string(originalMessages) {
		t.Fatalf("the copy differs: id=%v title=%q usage=%v messages equal=%v\n%s\n%s", copied.ID == imported, copied.Title, copied.Usage == original.Usage, string(copiedMessages) == string(originalMessages), copiedMessages, originalMessages)
	}
	if copied.Hidden == nil || len(copied.Hidden.Messages) != len(original.Hidden.Messages) {
		t.Fatal("the revert did not come along")
	}
	if err := r.Engine.UnrevertSession(r.Context, imported); err != nil {
		t.Fatalf("the imported conversation cannot be unreverted: %v", err)
	}
	if len(exported) != len(mustExport(t, r)) {
		t.Fatal("importing changed the original")
	}
	if _, err := r.Engine.ImportSession(r.Context, nil); err == nil {
		t.Fatal("nothing to import was accepted")
	}
	if _, err := r.Engine.ImportSession(r.Context, again[1:]); err == nil {
		t.Fatal("a stream that does not start with session.created was accepted")
	}
}

func mustExport(t *testing.T, r *enginetest.ChatRig) []event.Event {
	t.Helper()
	facts, err := r.Engine.ExportSession(r.Context, r.ID)
	if err != nil {
		t.Fatal(err)
	}
	return facts
}
