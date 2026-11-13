package migrate_test

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"errors"
	"path/filepath"
	"reflect"
	"regexp"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/TongTong313/merakcode/merak/engine"
	"github.com/TongTong313/merakcode/merak/engine/agent"
	"github.com/TongTong313/merakcode/merak/engine/event"
	"github.com/TongTong313/merakcode/merak/engine/group"
	"github.com/TongTong313/merakcode/merak/engine/model"
	"github.com/TongTong313/merakcode/merak/engine/model/fake"
	"github.com/TongTong313/merakcode/merak/engine/plan"
	"github.com/TongTong313/merakcode/merak/engine/session"
	"github.com/TongTong313/merakcode/merak/engine/store"
	"github.com/TongTong313/merakcode/merak/engine/tool"
	"github.com/TongTong313/merakcode/merak/engine/worker"
	"github.com/TongTong313/merakcode/merak/internal/localstore"
	"github.com/TongTong313/merakcode/merak/internal/migrate"
	"github.com/TongTong313/merakcode/merak/protocol"
)

const human = event.ID("local-human")

// at is a time in the v0.3 fixtures, in milliseconds since the epoch.
func at(minute int) int64 { return time.Date(2025, 5, 6, 7, minute, 0, 0, time.UTC).UnixMilli() }

// start builds an engine on a memory store and a migration of the fixture's root into it.
func start(t *testing.T, f *fixture, replies ...fake.Reply) (*engine.Engine, *migrate.Migration) {
	t.Helper()
	e, err := engine.New(engine.Deps{Workdir: t.TempDir(), Providers: map[string]model.Provider{"fake": fake.New(t, replies...)}})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { e.Close() })
	return e, migrate.New(migrate.Options{Root: f.root, Human: human, Engine: e})
}

func sessionsByTitle(t *testing.T, e *engine.Engine) map[string]session.Info {
	t.Helper()
	infos, err := e.ListSessions(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	result := map[string]session.Info{}
	for _, info := range infos {
		result[info.Title] = info
	}
	return result
}

// pngBytes is a small payload standing in for a picture.
var pngBytes = []byte{0x89, 'P', 'N', 'G', 0x0d, 0x0a, 0x1a, 0x0a, 7, 7, 7}

func twoSessionsWithAChild(t *testing.T, f *fixture, directory string) {
	t.Helper()
	f.session("ses_a", "", directory, "Fix the build", at(1), at(9), nil)
	f.user("ses_a", "msg_a1", at(1), "fake", "m-1", nil)
	f.text("ses_a", "msg_a1", "prt_a1", "Why does the build fail?")
	f.part("ses_a", "msg_a1", "prt_a2", obj{"type": "file", "mime": "image/png", "filename": "shot.png", "url": "data:image/png;base64," + base64.StdEncoding.EncodeToString(pngBytes)})
	f.assistant("ses_a", "msg_a2", at(2), at(3), "fake", "m-1", nil)
	f.part("ses_a", "msg_a2", "prt_b0", obj{"type": "step-start"})
	f.part("ses_a", "msg_a2", "prt_b1", obj{"type": "reasoning", "text": "The log mentions a missing file.", "time": obj{"start": at(2)}})
	f.text("ses_a", "msg_a2", "prt_b2", "Let me look at the log.")
	f.part("ses_a", "msg_a2", "prt_b3", obj{"type": "tool", "callID": "call_1", "tool": "bash", "state": obj{"status": "completed", "input": obj{"command": "cat build.log"}, "output": "error: missing main.go", "title": "cat", "metadata": obj{}, "time": obj{"start": at(2), "end": at(3)}}})
	f.part("ses_a", "msg_a2", "prt_b4", obj{"type": "step-finish", "reason": "tool-calls", "cost": 0, "tokens": obj{"input": 120, "output": 30, "reasoning": 0, "cache": obj{"read": 5, "write": 6}}})
	f.part("ses_a", "msg_a2", "prt_b5", obj{"type": "step-start"})
	f.text("ses_a", "msg_a2", "prt_b6", "main.go is missing from the package.")
	f.part("ses_a", "msg_a2", "prt_b7", obj{"type": "step-finish", "reason": "stop", "cost": 0, "tokens": obj{"input": 150, "output": 20, "reasoning": 0, "cache": obj{"read": 0, "write": 0}}})
	f.session("ses_child", "ses_a", directory, "Look into the log", at(3), at(4), nil)
	f.user("ses_child", "msg_c1", at(3), "fake", "m-1", nil)
	f.text("ses_child", "msg_c1", "prt_c1", "Read build.log and report.")
	f.assistant("ses_child", "msg_c2", at(3), at(4), "fake", "m-1", nil)
	f.text("ses_child", "msg_c2", "prt_c2", "It ends with a missing file error.")
	f.session("ses_b", "", directory, "Write the README", at(5), at(6), nil)
	f.user("ses_b", "msg_b1", at(5), "fake", "m-2", nil)
	f.text("ses_b", "msg_b1", "prt_d1", "Draft a README.")
	f.assistant("ses_b", "msg_b2", at(5), at(6), "fake", "m-2", nil)
	f.text("ses_b", "msg_b2", "prt_d2", "# Project")
}

func TestTwoConversationsAndAChildBecomeThreeWithTheirTitlesTimesTreeResultsAndPicture(t *testing.T) {
	f := newFixture(t)
	directory := t.TempDir()
	twoSessionsWithAChild(t, f, directory)
	e, m := start(t, f)
	result, err := m.Run(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	if result.Imported.Sessions != 3 || len(result.Skipped) != 0 {
		t.Fatalf("result = %+v", result)
	}
	byTitle := sessionsByTitle(t, e)
	if len(byTitle) != 3 {
		t.Fatalf("sessions = %+v", byTitle)
	}
	parent, child, other := byTitle["Fix the build"], byTitle["Look into the log"], byTitle["Write the README"]
	if !parent.CreatedAt.Equal(time.UnixMilli(at(1))) || !child.CreatedAt.Equal(time.UnixMilli(at(3))) || child.Config.Parent != parent.ID || other.Config.Parent != "" {
		t.Fatalf("times or tree wrong: parent=%+v child=%+v other=%+v", parent, child, other)
	}
	if parent.Config.Provider != "fake" || parent.Config.Model != "m-1" || parent.Config.Workdir != directory {
		t.Fatalf("config = %+v", parent.Config)
	}
	state, err := e.SessionSnapshot(t.Context(), parent.ID)
	if err != nil {
		t.Fatal(err)
	}
	// user, assistant (step 1), tool result, assistant (step 2)
	if len(state.Messages) != 4 {
		t.Fatalf("messages = %+v", state.Messages)
	}
	user := state.Messages[0]
	if user.Role != model.User || user.Parts[0].Text != "Why does the build fail?" || user.Parts[1].Image == nil || !strings.HasPrefix(user.Parts[1].Image.URL, "mrk://blob/") {
		t.Fatalf("user message = %+v", user)
	}
	blob, _, err := e.ReadBlob(t.Context(), user.Parts[1].Image.URL, 0, 0)
	if err != nil || !bytes.Equal(blob, pngBytes) {
		t.Fatalf("blob = %v (%v), want the picture", blob, err)
	}
	first := state.Messages[1]
	if first.Role != model.Assistant || first.Parts[0].Reasoning == nil || first.Parts[0].Reasoning.Text != "The log mentions a missing file." || first.Parts[1].Text != "Let me look at the log." || first.Parts[2].ToolCall == nil || first.Parts[2].ToolCall.ID != "call_1" || first.Parts[2].ToolCall.Name != "bash" {
		t.Fatalf("assistant step = %+v", first)
	}
	result1 := state.Messages[2]
	if result1.Role != model.Tool || result1.Parts[0].ToolResult == nil || result1.Parts[0].ToolResult.CallID != "call_1" || result1.Parts[0].ToolResult.IsError || result1.Parts[0].ToolResult.Parts[0].Text != "error: missing main.go" {
		t.Fatalf("tool result = %+v", result1)
	}
	if state.Messages[3].Parts[0].Text != "main.go is missing from the package." {
		t.Fatalf("last message = %+v", state.Messages[3])
	}
	if state.Usage.Input != 270 || state.Usage.Output != 50 || state.Usage.CacheRead != 5 || state.Usage.CacheWrite != 6 {
		t.Fatalf("usage = %+v", state.Usage)
	}
	if updated := lastEventTime(t, e, parent.ID); !updated.Equal(time.UnixMilli(at(9))) {
		t.Fatalf("the session was last active at %v, want the updated time of v0.3", updated)
	}
}

func lastEventTime(t *testing.T, e *engine.Engine, id event.ID) time.Time {
	t.Helper()
	facts, err := e.ReadEvents(t.Context(), event.Stream("session:"+id), 1, 0)
	if err != nil || len(facts) == 0 {
		t.Fatalf("events = %d (%v)", len(facts), err)
	}
	return facts[len(facts)-1].Time
}

// finished waits until a turn of the session ends.
func finished(t *testing.T, e *engine.Engine, id event.ID, run func()) {
	t.Helper()
	facts, stop := e.Bus.Subscribe(event.Filter{Scope: event.Scope{Session: id}, Types: []event.Type{"turn.finished"}})
	defer stop()
	run()
	select {
	case <-facts:
	case <-time.After(20 * time.Second):
		t.Fatal("the turn did not finish")
	}
}

func TestAnImportedConversationContinuesWithItsHistoryInTheModelRequest(t *testing.T) {
	f := newFixture(t)
	twoSessionsWithAChild(t, f, t.TempDir())
	var seen model.Request
	e, m := start(t, f, fake.Reply{Text: "Add main.go back.", Expect: func(request model.Request) error {
		seen = request
		return nil
	}})
	if _, err := m.Run(t.Context()); err != nil {
		t.Fatal(err)
	}
	parent := sessionsByTitle(t, e)["Fix the build"]
	finished(t, e, parent.ID, func() {
		if err := e.Send(t.Context(), parent.ID, []model.Part{{Text: "And how do I fix it?"}}); err != nil {
			t.Fatal(err)
		}
	})
	if seen.System == "" || len(seen.Messages) != 5 {
		t.Fatalf("system = %d bytes, messages = %d, want the history and the new message", len(seen.System), len(seen.Messages))
	}
	first := seen.Messages[0].Parts
	if first[0].Text != "Why does the build fail?" || first[1].Image == nil || !bytes.Equal(first[1].Image.Data, pngBytes) || first[1].Image.URL != "" {
		t.Fatalf("the picture did not reach the model as its bytes: %+v", first)
	}
	if seen.Messages[2].Parts[0].ToolResult == nil || seen.Messages[2].Parts[0].ToolResult.Parts[0].Text != "error: missing main.go" {
		t.Fatalf("the tool result is missing: %+v", seen.Messages[2])
	}
	if last := seen.Messages[4].Parts[0].Text; last != "And how do I fix it?" {
		t.Fatalf("last message = %q", last)
	}
}

func TestAConversationWhoseFolderIsGoneIsImportedWithAWarning(t *testing.T) {
	f := newFixture(t)
	gone := t.TempDir() + "/removed"
	f.session("ses_gone", "", gone, "Old project", at(1), at(2), nil)
	f.user("ses_gone", "msg_1", at(1), "fake", "m", nil)
	f.text("ses_gone", "msg_1", "prt_1", "hello")
	e, m := start(t, f)
	result, err := m.Run(t.Context())
	if err != nil || result.Imported.Sessions != 1 || len(result.Skipped) != 0 {
		t.Fatalf("result = %+v (%v)", result, err)
	}
	state, err := e.SessionSnapshot(t.Context(), sessionsByTitle(t, e)["Old project"].ID)
	if err != nil {
		t.Fatal(err)
	}
	if len(state.Warnings) != 1 || state.Warnings[0].Code != "MRK-3008" || state.Config.Workdir != gone || len(state.Messages) != 1 {
		t.Fatalf("state = %+v", state)
	}
}

func TestADamagedPartSkipsOnlyItsConversationAndTheResultSaysWhy(t *testing.T) {
	f := newFixture(t)
	directory := t.TempDir()
	f.session("ses_bad", "", directory, "Broken", at(1), at(2), nil)
	f.user("ses_bad", "msg_1", at(1), "fake", "m", nil)
	f.rawPart("ses_bad", "msg_1", "prt_bad", `{"type":"text","text":"cut off`)
	f.session("ses_ok", "", directory, "Fine", at(3), at(4), nil)
	f.user("ses_ok", "msg_2", at(3), "fake", "m", nil)
	f.text("ses_ok", "msg_2", "prt_ok", "hello")
	e, m := start(t, f)
	result, err := m.Run(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	if result.Imported.Sessions != 1 || len(result.Skipped) != 1 {
		t.Fatalf("result = %+v", result)
	}
	skipped := result.Skipped[0]
	if skipped.Kind != "session" || skipped.ID != "ses_bad" || skipped.Code != "MRK-4021" || !strings.Contains(skipped.Reason, "prt_bad") || strings.Contains(skipped.Reason, "cut off") {
		t.Fatalf("skipped = %+v", skipped)
	}
	if byTitle := sessionsByTitle(t, e); len(byTitle) != 1 || byTitle["Fine"].ID == "" {
		t.Fatalf("sessions = %+v", byTitle)
	}
}

func inboxNotices(t *testing.T, e *engine.Engine) []group.Notice {
	t.Helper()
	facts, err := e.FindEvents(t.Context(), store.Query{Types: []event.Type{group.NoticeSent}})
	if err != nil {
		t.Fatal(err)
	}
	var notices []group.Notice
	for _, fact := range facts {
		if fact.Stream != event.Stream("inbox:"+human) {
			continue
		}
		notice, err := event.Decode[group.Notice](fact)
		if err != nil {
			t.Fatal(err)
		}
		notices = append(notices, notice)
	}
	return notices
}

func TestARunReportsProgressTellsTheInboxAndLeavesTheFilesOfV03Alone(t *testing.T) {
	f := newFixture(t)
	twoSessionsWithAChild(t, f, t.TempDir())
	e, m := start(t, f)
	progress, stop := e.Bus.Subscribe(event.Filter{Types: []event.Type{protocol.ImportProgress}})
	defer stop()
	before := f.snapshot()
	result, err := m.Run(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	if after := f.snapshot(); !reflect.DeepEqual(before, after) {
		t.Fatal("the files of v0.3 changed")
	}
	var reports []protocol.ImportProgressPayload
	for len(progress) > 0 {
		report, err := event.Decode[protocol.ImportProgressPayload](<-progress)
		if err != nil {
			t.Fatal(err)
		}
		reports = append(reports, report)
	}
	if len(reports) != 4 || reports[0].Done != 0 || reports[3].Done != 3 || reports[3].Total != 3 || reports[3].From != "v0.3" {
		t.Fatalf("progress = %+v, want one report before and one after each of three conversations", reports)
	}
	notices := inboxNotices(t, e)
	if len(notices) != 1 || notices[0].Kind != "import" || notices[0].Count != 0 {
		t.Fatalf("notices = %+v", notices)
	}
	var told protocol.ImportResult
	if err := json.Unmarshal([]byte(notices[0].Text), &told); err != nil || told.Imported.Sessions != 3 || told.Imported.Sessions != result.Imported.Sessions {
		t.Fatalf("the notice says %+v (%v)", told, err)
	}
	status := m.Status()
	if status.State != "done" || !status.Found || status.Result == nil || status.Result.Imported.Sessions != 3 || status.Done != 3 {
		t.Fatalf("status = %+v", status)
	}
}

func TestRunningAgainImportsNothingAgainAndOnlyAConversationThatAppearedIsTaken(t *testing.T) {
	f := newFixture(t)
	directory := t.TempDir()
	twoSessionsWithAChild(t, f, directory)
	e, m := start(t, f)
	if _, err := m.Run(t.Context()); err != nil {
		t.Fatal(err)
	}
	again, err := m.Run(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	if again.Imported != (protocol.ImportCounts{}) || len(again.Skipped) != 0 || len(sessionsByTitle(t, e)) != 3 || len(inboxNotices(t, e)) != 1 {
		t.Fatalf("a second run did something: %+v, %d sessions, %d notices", again, len(sessionsByTitle(t, e)), len(inboxNotices(t, e)))
	}
	f.session("ses_new", "", directory, "Added later", at(20), at(21), nil)
	f.user("ses_new", "msg_n1", at(20), "fake", "m", nil)
	f.text("ses_new", "msg_n1", "prt_n1", "one more")
	third, err := m.Run(t.Context())
	if err != nil || third.Imported.Sessions != 1 || len(sessionsByTitle(t, e)) != 4 || len(inboxNotices(t, e)) != 2 {
		t.Fatalf("third run = %+v (%v), %d sessions", third, err, len(sessionsByTitle(t, e)))
	}
}

func TestWhatWasImportedSurvivesARestartOfTheEngine(t *testing.T) {
	f := newFixture(t)
	twoSessionsWithAChild(t, f, t.TempDir())
	local, err := localstore.Open(filepath.Join(t.TempDir(), "merak.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer local.Close()
	for round, wantSessions := range []int{3, 0} {
		e, err := engine.New(engine.Deps{Workdir: t.TempDir(), Store: local})
		if err != nil {
			t.Fatal(err)
		}
		result, err := migrate.New(migrate.Options{Root: f.root, Human: human, Engine: e}).Run(t.Context())
		if err != nil || result.Imported.Sessions != wantSessions {
			t.Fatalf("round %d: %+v (%v)", round, result, err)
		}
		infos, _ := e.ListSessions(t.Context())
		if len(infos) != 3 {
			t.Fatalf("round %d: %d sessions", round, len(infos))
		}
		e.Close()
	}
}

const v03Config = `{
  // external products of v0.3
  "agentConnections": {
    "products": {
      "claude": {"adapter": "claude", "title": "Claude Code", "command": "claude-bin", "args": ["--verbose"], "model": {"id": "opus"}},
      "codex": {"adapter": "codex", "enabled": false},
      "scribe": {"adapter": "member", "title": "Scribe", "command": "node"},
      "runner": {"adapter": "command", "title": "Runner", "command": "run-it", "args": ["-x"]},
      "broken": {"adapter": "command"}
    }
  },
  "collaboration": {
    "roleTemplates": {
      "reviewer": {"name": "Reviewer", "role": "Code reviewer", "duty": "Reads every change before it is merged."}
    }
  },
}`

func TestExternalProductsBecomeAgentsRoleTemplatesBecomeWorkersAndAHandWrittenAdapterIsListed(t *testing.T) {
	f := newFixture(t)
	f.file("merakcode.jsonc", v03Config)
	e, m := start(t, f)
	result, err := m.Run(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	if result.Imported.Agents != 2 || result.Imported.Roles != 1 || !reflect.DeepEqual(result.Adapters, []string{"scribe"}) {
		t.Fatalf("result = %+v", result)
	}
	codes := map[string]string{}
	for _, skipped := range result.Skipped {
		codes[skipped.ID] = skipped.Code
	}
	if codes["scribe"] != "MRK-5017" || codes["codex"] != "MRK-4023" || codes["broken"] != "MRK-4023" || len(codes) != 3 {
		t.Fatalf("skipped = %+v", result.Skipped)
	}
	listed, err := e.ListAgents(t.Context(), human)
	if err != nil {
		t.Fatal(err)
	}
	byName := map[string]agent.Agent{}
	for _, one := range listed {
		byName[one.Name] = one
	}
	claude, runner, reviewer := byName["Claude Code"], byName["Runner"], byName["Reviewer"]
	if claude.Product == nil || claude.Product.Kind != worker.KindClaudeCode || claude.Product.Binary != "claude-bin" || !reflect.DeepEqual(claude.Product.Args, []string{"--verbose"}) || claude.Product.Model != "opus" {
		t.Fatalf("claude = %+v", claude)
	}
	if runner.Product == nil || runner.Product.Kind != worker.KindCommand || runner.Product.Binary != "run-it" {
		t.Fatalf("runner = %+v", runner)
	}
	if reviewer.Product != nil || reviewer.Summary != "Code reviewer" || reviewer.Duties != "Reads every change before it is merged." {
		t.Fatalf("reviewer = %+v", reviewer)
	}
	if _, found := byName["Scribe"]; found {
		t.Fatal("a hand-written adapter was imported")
	}
	again, err := m.Run(t.Context())
	if err != nil || again.Imported.Agents != 0 || again.Imported.Roles != 0 {
		t.Fatalf("second run = %+v (%v)", again, err)
	}
	if listed, _ = e.ListAgents(t.Context(), human); len(listed) != 4 {
		t.Fatalf("%d agents after a second run, want the builtin one and three imported", len(listed))
	}
}

// v03Key spells the directory name that v0.3 gave the memory of a project, written out again here from its rule: the
// drive colon goes, runs of characters a file name cannot hold become one dash, and dashes at the ends go.
func v03Key(path string) string {
	path = regexp.MustCompile(`^([A-Za-z]):`).ReplaceAllString(path, "$1")
	path = regexp.MustCompile(`[<>:"/\\|?*]+`).ReplaceAllString(path, "-")
	return strings.Trim(regexp.MustCompile(`-+`).ReplaceAllString(path, "-"), "-")
}

func TestTodoListsPlansAndMemoriesArriveAndANoteWithAKeyOrWithoutAProjectIsHeldBack(t *testing.T) {
	f := newFixture(t)
	directory := t.TempDir()
	twoSessionsWithAChild(t, f, directory)
	f.record("todo/ses_a", []obj{
		{"id": "1", "content": "Find the log", "status": "completed", "priority": "high"},
		{"id": "2", "content": "Restore main.go", "status": "in_progress", "priority": "high"},
		{"id": "3", "content": "Tell the team", "status": "pending", "priority": "low"},
		{"id": "4", "content": "Drop the idea", "status": "cancelled", "priority": "low"},
	})
	f.record("session_plan/ses_a", obj{"sessionID": "ses_a", "path": "x", "content": "# Plan\n1. Restore main.go", "revision": 3, "status": "completed"})
	f.file("data/plans/"+strconv.FormatInt(at(5), 10)+"-slug-ses_b.md", "# Plan B\n1. Write it")
	f.file("data/memory/projects/"+v03Key(directory)+"/user/role.md", "---\nname: Role\ndescription: The user is a build engineer\ntype: user\n---\n\nPrefers short answers.\n")
	f.file("data/memory/projects/"+v03Key(directory)+"/project/key.md", "---\nname: Deploy key\ndescription: How deploys work\ntype: project\n---\n\nThe token is sk-ant-"+strings.Repeat("a1", 15)+" for deploys.\n")
	f.file("data/memory/projects/"+v03Key(directory)+"/MEMORY.md", "# index\n")
	f.file("data/memory/projects/some-other-project/reference/board.md", "---\nname: Board\ndescription: Where the tickets are\ntype: reference\n---\n\nSee the board.\n")
	e, m := start(t, f)
	result, err := m.Run(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	if result.Imported.Todos != 1 || result.Imported.Plans != 2 || result.Imported.Memories != 1 {
		t.Fatalf("result = %+v", result)
	}
	codes := map[string]string{}
	for _, skipped := range result.Skipped {
		codes[skipped.Kind+":"+skipped.Code] = skipped.ID
	}
	if len(result.Skipped) != 3 || codes["todo:MRK-4023"] != "ses_a" || codes["memory:MRK-5018"] == "" || codes["memory:MRK-5019"] == "" {
		t.Fatalf("skipped = %+v", result.Skipped)
	}
	byTitle := sessionsByTitle(t, e)
	state, err := e.SessionSnapshot(t.Context(), byTitle["Fix the build"].ID)
	if err != nil {
		t.Fatal(err)
	}
	wantTodos := []tool.Todo{{Content: "Find the log", Status: "done"}, {Content: "Restore main.go", Status: "in_progress"}, {Content: "Tell the team", Status: "pending"}}
	if !reflect.DeepEqual(state.Todos, wantTodos) {
		t.Fatalf("todos = %+v", state.Todos)
	}
	done, err := e.GetPlan(t.Context(), byTitle["Fix the build"].ID)
	if err != nil || done.Status != plan.Done || done.Content != "# Plan\n1. Restore main.go" {
		t.Fatalf("plan = %+v (%v)", done, err)
	}
	stopped, err := e.GetPlan(t.Context(), byTitle["Write the README"].ID)
	if err != nil || stopped.Status != plan.Stopped || stopped.Content != "# Plan B\n1. Write it" {
		t.Fatalf("plan from the file = %+v (%v)", stopped, err)
	}
	notes, err := e.MemoryList(t.Context(), directory, "")
	if err != nil || len(notes) != 1 || notes[0].Kind != "preference" || !strings.Contains(notes[0].Text, "Prefers short answers.") || !strings.Contains(notes[0].Text, "The user is a build engineer") {
		t.Fatalf("notes = %+v (%v)", notes, err)
	}
	again, err := m.Run(t.Context())
	if err != nil || again.Imported.Plans != 0 || again.Imported.Memories != 0 {
		t.Fatalf("second run = %+v (%v)", again, err)
	}
	if notes, _ = e.MemoryList(t.Context(), directory, ""); len(notes) != 1 {
		t.Fatalf("%d notes after a second run", len(notes))
	}
}

func TestACollaborationGroupBecomesAnArchivedReadOnlyGroupWithItsMembersAndMessages(t *testing.T) {
	f := newFixture(t)
	directory := t.TempDir()
	f.file("merakcode.jsonc", v03Config)
	f.session("ses_group", "", directory, "Release team", at(1), at(8), obj{"metadata": obj{"group": true}})
	f.record("collaboration/ses_group", obj{"seq": 4, "baseline": []string{}, "events": []obj{}, "results": []obj{}, "seats": []obj{
		{"id": "s1", "name": "Lead", "role": "Lead", "duty": "Keeps the plan", "product": "merak", "leader": true},
		{"id": "s2", "name": "Dana", "role": "Developer", "duty": "Writes code", "product": "claude", "leader": false},
		{"id": "s3", "name": "Reviewer", "role": "Code reviewer", "duty": "Reads changes", "product": "merak", "leader": false},
	}})
	f.record("todo/ses_group", []obj{{"id": "1", "content": "Cut the release", "status": "pending", "priority": "high"}})
	f.user("ses_group", "msg_g1", at(2), "fake", "m", nil)
	f.text("ses_group", "msg_g1", "prt_g1", "@Dana please start the release branch")
	f.assistant("ses_group", "msg_g2", at(3), at(4), "fake", "m", nil)
	f.text("ses_group", "msg_g2", "prt_g2", "Dana is on it.")
	e, m := start(t, f)
	result, err := m.Run(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	if result.Imported.Groups != 1 || result.Imported.Sessions != 0 || result.Imported.Messages != 2 {
		t.Fatalf("result = %+v", result)
	}
	if infos, _ := e.ListSessions(t.Context()); len(infos) != 0 {
		t.Fatalf("the chat of the group became %d conversations", len(infos))
	}
	groups, err := e.Groups.List(t.Context(), human)
	if err != nil || len(groups) != 1 || !groups[0].Archived || groups[0].Name != "Release team" || groups[0].Project.Directory != directory {
		t.Fatalf("groups = %+v (%v)", groups, err)
	}
	state, err := e.Groups.Get(t.Context(), groups[0].ID)
	if err != nil {
		t.Fatal(err)
	}
	members := map[string]group.Member{}
	for _, member := range state.Members {
		members[member.Name] = member
	}
	if len(members) != 4 || members["Owner"].Kind != group.MemberHuman || !members["Owner"].Can(group.RoleOwner) {
		t.Fatalf("members = %+v", state.Members)
	}
	if lead := members["Lead"]; lead.AgentRole != group.AgentLeader || lead.Agent != "builtin-merakcode" || state.Group.Leader != lead.ID {
		t.Fatalf("leader = %+v of group %+v", lead, state.Group)
	}
	byName := map[string]agent.Agent{}
	listed, _ := e.ListAgents(t.Context(), human)
	for _, one := range listed {
		byName[one.Name] = one
	}
	if members["Dana"].Agent != byName["Claude Code"].ID || members["Dana"].AgentRole != group.AgentWorker || members["Dana"].Role != "Developer" {
		t.Fatalf("Dana = %+v, the imported Claude Code agent is %q", members["Dana"], byName["Claude Code"].ID)
	}
	if members["Reviewer"].Agent != byName["Reviewer"].ID || byName["Reviewer"].ID == "" {
		t.Fatalf("Reviewer = %+v, the imported template agent is %q", members["Reviewer"], byName["Reviewer"].ID)
	}
	facts, err := e.FindEvents(t.Context(), store.Query{Scope: event.Scope{Group: groups[0].ID}, Types: []event.Type{group.HumanSaid, session.MessageCompleted}})
	if err != nil || len(facts) != 2 || !facts[0].Time.Equal(time.UnixMilli(at(2))) || facts[0].Type != group.HumanSaid || facts[1].Type != session.MessageCompleted {
		t.Fatalf("messages = %+v (%v)", facts, err)
	}
	said, _ := event.Decode[group.Message](facts[0])
	reply, _ := event.Decode[session.Completion](facts[1])
	if said.Text != "@Dana please start the release branch" || reply.Parts[0].Text != "Dana is on it." {
		t.Fatalf("said = %+v reply = %+v", said, reply)
	}
	var refused *engine.Error
	if _, err := e.SayGroup(t.Context(), groups[0].ID, "", human, group.Message{Text: "continue"}); !errors.As(err, &refused) || refused.Code != "MRK-4020" {
		t.Fatalf("saying in the group: %v", err)
	}
	todoSkips := 0
	for _, skipped := range result.Skipped {
		if skipped.Kind == "todo" && skipped.ID == "ses_group" {
			todoSkips++
		}
	}
	if again := mustRun(t, m); todoSkips != 1 || again.Imported.Groups != 0 || len(sessionsByTitle(t, e)) != 0 || len(inboxNotices(t, e)) != 1 {
		t.Fatalf("skipped = %+v, second run = %+v", result.Skipped, again)
	}
}

func mustRun(t *testing.T, m *migrate.Migration) protocol.ImportResult {
	t.Helper()
	result, err := m.Run(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	return result
}

func TestACompactionSummaryReplacesWhatCameBeforeItAndAnUnfinishedToolCallEndsInterrupted(t *testing.T) {
	f := newFixture(t)
	directory := t.TempDir()
	f.session("ses_c", "", directory, "New session - 2025-05-06T07:00:00.000Z", at(1), at(9), obj{"permissionLevel": "fullTakeover"})
	f.user("ses_c", "m1", at(1), "fake", "m", nil)
	f.text("ses_c", "m1", "p1", "first question")
	f.assistant("ses_c", "m2", at(2), at(2), "fake", "m", nil)
	f.part("ses_c", "m2", "p2", obj{"type": "tool", "callID": "c1", "tool": "bash", "state": obj{"status": "running", "input": obj{"command": "sleep 99"}, "time": obj{"start": at(2)}}})
	f.user("ses_c", "m3", at(3), "fake", "m", nil)
	f.part("ses_c", "m3", "p3", obj{"type": "compaction", "auto": false})
	f.assistant("ses_c", "m4", at(4), at(4), "fake", "m", obj{"summary": true})
	f.text("ses_c", "m4", "p4", "SUMMARY of the work so far")
	f.user("ses_c", "m5", at(5), "fake", "m", nil)
	f.text("ses_c", "m5", "p5", "next question")
	e, m := start(t, f)
	if result, err := m.Run(t.Context()); err != nil || result.Imported.Sessions != 1 {
		t.Fatalf("result = %+v (%v)", result, err)
	}
	infos, _ := e.ListSessions(t.Context())
	state, err := e.SessionSnapshot(t.Context(), infos[0].ID)
	if err != nil {
		t.Fatal(err)
	}
	if len(state.Messages) != 2 || state.Messages[0].Parts[0].Text != "SUMMARY of the work so far" || state.Messages[1].Parts[0].Text != "next question" {
		t.Fatalf("messages = %+v", state.Messages)
	}
	if state.Title != "" || state.Config.Mode != "ask" {
		t.Fatalf("title = %q mode = %q, want no automatic title kept and no takeover carried over", state.Title, state.Config.Mode)
	}
	facts, err := e.FindEvents(t.Context(), store.Query{Scope: event.Scope{Session: infos[0].ID}, Types: []event.Type{"tool.completed"}})
	if err != nil || len(facts) != 1 {
		t.Fatalf("tool results = %+v (%v)", facts, err)
	}
	finished, _ := event.Decode[tool.Completion](facts[0])
	if !finished.IsError || finished.CallID != "c1" || finished.Code != "MRK-5003" {
		t.Fatalf("result of the unfinished call = %+v", finished)
	}
}

func TestWithoutADatabaseARunFailsWithItsCodeAndTheBackgroundStartWaitsForOne(t *testing.T) {
	root := t.TempDir()
	e, err := engine.New(engine.Deps{Workdir: t.TempDir()})
	if err != nil {
		t.Fatal(err)
	}
	defer e.Close()
	m := migrate.New(migrate.Options{Root: root, Human: human, Engine: e})
	var failure *engine.Error
	if _, err := m.Run(t.Context()); !errors.As(err, &failure) || failure.Code != "MRK-3007" {
		t.Fatalf("err = %v", err)
	}
	m.StartIfNeeded(t.Context())
	if status := m.Status(); status.Found || status.State != "idle" {
		t.Fatalf("status = %+v", status)
	}
}

func TestTheDaemonStartsTheMigrationInTheBackgroundOnceAndNotAgainAfterItFinished(t *testing.T) {
	f := newFixture(t)
	twoSessionsWithAChild(t, f, t.TempDir())
	e, m := start(t, f)
	defer m.Close()
	m.StartIfNeeded(t.Context())
	deadline := time.Now().Add(20 * time.Second)
	for m.Status().State != "done" {
		if time.Now().After(deadline) {
			t.Fatalf("status = %+v", m.Status())
		}
		time.Sleep(10 * time.Millisecond)
	}
	if status := m.Status(); !status.Found || status.Result.Imported.Sessions != 3 || len(sessionsByTitle(t, e)) != 3 {
		t.Fatalf("status = %+v", status)
	}
	if !m.Imported(t.Context()) {
		t.Fatal("a finished migration is not remembered")
	}
	fresh := migrate.New(migrate.Options{Root: f.root, Human: human, Engine: e})
	fresh.StartIfNeeded(t.Context())
	if status := fresh.Status(); status.State != "idle" {
		t.Fatalf("a restarted daemon began again: %+v", status)
	}
}
