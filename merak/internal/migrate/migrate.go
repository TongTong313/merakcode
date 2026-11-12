// Package migrate carries the data of an earlier MerakCode version into the engine: conversations, groups, agents,
// plans, memories and todo lists. It only reads the files of the earlier version.
package migrate

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"os"
	"slices"
	"sync"

	"github.com/TongTong313/merakcode/merak/engine"
	"github.com/TongTong313/merakcode/merak/engine/event"
	"github.com/TongTong313/merakcode/merak/engine/group"
	"github.com/TongTong313/merakcode/merak/engine/store"
	"github.com/TongTong313/merakcode/merak/engine/tool"
	"github.com/TongTong313/merakcode/merak/internal/platform/errorcode"
	"github.com/TongTong313/merakcode/merak/protocol"
)

// From names the version this package reads. It is also the key of the record that keeps what was imported.
const From = "v0.3"

const (
	codeNoSource    = errorcode.ImportSourceNotFound
	codeSession     = errorcode.ImportSessionSkipped
	codeFailed      = errorcode.ImportFailed
	codeRecord      = errorcode.ImportRecordSkipped
	codeAdapter     = errorcode.ImportAdapterUnsupported
	codeMemory      = errorcode.ImportMemoryBlocked
	codeMemoryOwner = errorcode.ImportMemoryProjectUnknown
)

// maxReported bounds the skipped entries that the notice carries; the result of a run lists all of them.
const maxReported = 50

// Options says what to import and where it goes.
type Options struct {
	// Root is the MerakCode root of the earlier version: ~/.merakcode, or what MERAKCODE_HOME names.
	Root string
	// Human is the person the imported things belong to.
	Human  event.ID
	Engine *engine.Engine
	Logger *slog.Logger
}

// Migration imports the data of v0.3 once: what a run imported is recorded, and the next run takes only what is new.
type Migration struct {
	options Options
	mu      sync.Mutex
	state   string
	done    int
	total   int
	result  *protocol.ImportResult
	cancel  context.CancelFunc
	wait    sync.WaitGroup
	closed  bool
}

func New(options Options) *Migration { return &Migration{options: options, state: "idle"} }

// record is what is kept in the store after each conversation: which things of v0.3 are in v1 already.
type record struct {
	Done     bool              `json:"done"`
	Sessions map[string]string `json:"sessions"`
	Groups   map[string]string `json:"groups"`
	Agents   map[string]string `json:"agents"`
	Plans    []string          `json:"plans"`
	Memories []string          `json:"memories"`
}

// run is the state of one run.
type run struct {
	m      *Migration
	ctx    context.Context
	db     *source
	record record
	rev    uint64
	result protocol.ImportResult
	// directories are the folders of the conversations by their identifier in v0.3.
	directories map[string]string
	// ids are the conversations of this run and of earlier runs by their identifier in v0.3.
	infos map[string]v03Session
	todos map[string][]tool.Todo
}

func (m *Migration) log() *slog.Logger {
	if m.options.Logger != nil {
		return m.options.Logger
	}
	return slog.New(slog.DiscardHandler)
}

// Found says that the database of v0.3 is on this machine.
func (m *Migration) Found() bool {
	_, err := os.Stat(databasePath(m.options.Root))
	return err == nil
}

// Status tells what the migration is doing now.
func (m *Migration) Status() protocol.ImportStatus {
	m.mu.Lock()
	defer m.mu.Unlock()
	status := protocol.ImportStatus{Found: m.Found(), State: m.state, Done: m.done, Total: m.total}
	if m.result != nil {
		copied := *m.result
		status.Result = &copied
	}
	return status
}

// Imported says that a migration has finished before.
func (m *Migration) Imported(ctx context.Context) bool {
	current, _, err := m.read(ctx)
	return err == nil && current.Done
}

// StartIfNeeded begins the migration in the background when the database of v0.3 is there and no migration has
// finished; it is called when the engine starts.
func (m *Migration) StartIfNeeded(ctx context.Context) {
	if m.Found() && !m.Imported(ctx) {
		m.Start()
	}
}

// Start runs the migration in the background and says whether it began; it does not begin while one is running.
func (m *Migration) Start() bool {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.state == "running" || m.closed {
		return false
	}
	ctx, cancel := context.WithCancel(context.Background())
	m.cancel, m.state, m.done, m.total, m.result = cancel, "running", 0, 0, nil
	m.wait.Go(func() {
		if _, err := m.run(ctx); err != nil {
			m.log().Warn("import from v0.3 stopped", "code", errorCode(err))
		}
	})
	return true
}

// Close stops a running migration and waits for it.
func (m *Migration) Close() {
	m.mu.Lock()
	m.closed = true
	cancel := m.cancel
	m.mu.Unlock()
	if cancel != nil {
		cancel()
	}
	m.wait.Wait()
}

func errorCode(err error) string {
	var coded *engine.Error
	if errors.As(err, &coded) {
		return coded.Code
	}
	return codeFailed
}

// Run imports what is not imported yet and returns what it did.
func (m *Migration) Run(ctx context.Context) (protocol.ImportResult, error) {
	m.mu.Lock()
	if m.state == "running" {
		m.mu.Unlock()
		return protocol.ImportResult{}, &engine.Error{Code: codeFailed, Err: errors.New("a migration is running")}
	}
	m.state, m.done, m.total, m.result = "running", 0, 0, nil
	m.mu.Unlock()
	return m.run(ctx)
}

func (m *Migration) run(ctx context.Context) (protocol.ImportResult, error) {
	result, err := m.execute(ctx)
	m.mu.Lock()
	defer m.mu.Unlock()
	if err != nil {
		m.state = "idle"
		return result, err
	}
	m.state, m.result = "done", &result
	return result, nil
}

func (m *Migration) read(ctx context.Context) (record, uint64, error) {
	current := record{Sessions: map[string]string{}, Groups: map[string]string{}, Agents: map[string]string{}}
	body, rev, err := m.options.Engine.ReadImport(ctx, From)
	if errors.Is(err, store.ErrNotFound) {
		return current, 0, nil
	}
	if err != nil {
		return current, 0, err
	}
	if err := json.Unmarshal(body, &current); err != nil {
		return current, 0, err
	}
	for _, table := range []*map[string]string{&current.Sessions, &current.Groups, &current.Agents} {
		if *table == nil {
			*table = map[string]string{}
		}
	}
	return current, rev, nil
}

// save writes the record after a step, so a run that stops half way is continued by the next one.
func (r *run) save() error {
	body, err := json.Marshal(r.record)
	if err != nil {
		return err
	}
	if err := r.m.options.Engine.WriteImport(r.ctx, From, body, r.rev); err != nil {
		return err
	}
	_, r.rev, err = r.m.options.Engine.ReadImport(r.ctx, From)
	return err
}

func (r *run) skip(kind, id, code string, reason error) {
	text := ""
	if reason != nil {
		text = reason.Error()
	}
	r.result.Skipped = append(r.result.Skipped, protocol.ImportSkip{Kind: kind, ID: id, Code: code, Reason: text})
}

func (m *Migration) execute(ctx context.Context) (protocol.ImportResult, error) {
	path := databasePath(m.options.Root)
	if _, err := os.Stat(path); err != nil {
		return protocol.ImportResult{}, &engine.Error{Code: codeNoSource, Err: errors.New("data/merakcode.db was not found")}
	}
	db, err := openSource(path)
	if err != nil {
		return protocol.ImportResult{}, &engine.Error{Code: codeFailed, Err: fmt.Errorf("the database cannot be opened: %w", err)}
	}
	defer db.Close()
	current, rev, err := m.read(ctx)
	if err != nil {
		return protocol.ImportResult{}, &engine.Error{Code: codeFailed, Err: err}
	}
	r := &run{m: m, ctx: ctx, db: db, record: current, rev: rev, result: protocol.ImportResult{From: From, Skipped: []protocol.ImportSkip{}}, directories: map[string]string{}, infos: map[string]v03Session{}, todos: map[string][]tool.Todo{}}
	if err := r.all(); err != nil {
		return r.result, &engine.Error{Code: codeFailed, Err: err}
	}
	return r.result, nil
}

func (r *run) all() error {
	rows, err := r.db.sessions(r.ctx)
	if err != nil {
		return err
	}
	var pending []v03Session
	for _, row := range rows {
		info, err := decode[v03Session]("session", row.ID, row.Data)
		if err != nil || info.ID != row.ID {
			r.skip("session", row.ID, codeSession, errors.New("the session record is not valid"))
			continue
		}
		r.infos[info.ID] = info
		if _, done := r.record.Sessions[info.ID]; done {
			continue
		}
		if _, done := r.record.Groups[info.ID]; done {
			continue
		}
		pending = append(pending, info)
	}
	if err := r.readTodos(); err != nil {
		return err
	}
	r.m.progress(r.ctx, 0, len(pending))
	r.importAgents()
	done := 0
	step := func() {
		done++
		r.m.progress(r.ctx, done, len(pending))
	}
	for _, info := range orderByParent(pending, r.record) {
		if err := r.ctx.Err(); err != nil {
			return err
		}
		if info.isGroup() {
			r.importGroup(info)
		} else {
			r.importSession(info)
		}
		step()
	}
	if err := r.importPlans(); err != nil {
		return err
	}
	if err := r.importMemories(); err != nil {
		return err
	}
	return r.finish()
}

// finish records that the run is over and tells the person in the inbox, unless nothing happened.
func (r *run) finish() error {
	first := !r.record.Done
	r.record.Done = true
	if err := r.save(); err != nil {
		return err
	}
	// Later runs speak up only when they brought something in; the first one also reports what it left out.
	if r.result.Imported == (protocol.ImportCounts{}) && (!first || len(r.result.Skipped) == 0) {
		return nil
	}
	reported := r.result
	if len(reported.Skipped) > maxReported {
		reported.Skipped = reported.Skipped[:maxReported]
	}
	text, err := json.Marshal(reported)
	if err != nil {
		return err
	}
	return r.m.options.Engine.Notify(r.ctx, r.m.options.Human, group.Notice{Kind: "import", Text: string(text), Count: len(r.result.Skipped)})
}

// progress publishes how far the migration is.
func (m *Migration) progress(ctx context.Context, done, total int) {
	m.mu.Lock()
	m.done, m.total = done, total
	m.mu.Unlock()
	body, err := json.Marshal(protocol.ImportProgressPayload{From: From, Done: done, Total: total})
	if err != nil {
		return
	}
	_, _ = m.options.Engine.Bus.Publish(ctx, event.Event{Stream: event.Stream("import:" + From), Type: protocol.ImportProgress, Actor: event.Actor{Kind: event.ActorSystem}, Payload: body})
}

// orderByParent puts every conversation after its parent, so a child can name the id its parent got.
func orderByParent(infos []v03Session, imported record) []v03Session {
	waiting := map[string]bool{}
	for _, info := range infos {
		waiting[info.ID] = true
	}
	var ordered []v03Session
	placed := map[string]bool{}
	for len(ordered) < len(infos) {
		before := len(ordered)
		for _, info := range infos {
			if placed[info.ID] || waiting[info.ParentID] && !placed[info.ParentID] {
				continue
			}
			placed[info.ID] = true
			ordered = append(ordered, info)
		}
		if len(ordered) == before {
			for _, info := range infos {
				if !placed[info.ID] {
					ordered = append(ordered, info)
					placed[info.ID] = true
				}
			}
		}
	}
	return ordered
}

func (r *run) readTodos() error {
	rows, err := r.db.records(r.ctx, "todo/")
	if err != nil {
		return err
	}
	for _, row := range rows {
		items, err := decode[[]v03Todo]("todo list", row.ID, row.Data)
		if err != nil {
			r.skip("todo", row.ID, codeRecord, err)
			continue
		}
		var kept []tool.Todo
		dropped := 0
		for _, item := range items {
			switch item.Status {
			case "pending", "in_progress":
				kept = append(kept, tool.Todo{Content: item.Content, Status: item.Status})
			case "completed":
				kept = append(kept, tool.Todo{Content: item.Content, Status: "done"})
			default:
				dropped++
			}
		}
		if dropped > 0 {
			r.skip("todo", row.ID, codeRecord, errors.New("items that were cancelled have no equivalent"))
		}
		r.todos[row.ID] = kept
	}
	return nil
}

func (r *run) importSession(info v03Session) {
	loaded, err := load(r.ctx, r.db, info)
	if err != nil {
		r.skip("session", info.ID, codeSession, err)
		return
	}
	var parent event.ID
	if known := r.record.Sessions[info.ParentID]; known != "" {
		parent = event.ID(known)
	}
	todos := r.todos[info.ID]
	facts, blobs, messages, err := conversationFacts(r.ctx, r.m.options.Engine, loaded, parent, todos)
	if err != nil {
		r.skip("session", info.ID, codeSession, err)
		return
	}
	id, err := r.m.options.Engine.ImportConversation(r.ctx, facts)
	if err != nil {
		r.skip("session", info.ID, codeSession, err)
		return
	}
	r.record.Sessions[info.ID] = string(id)
	r.directories[info.ID] = info.Directory
	r.result.Imported.Sessions++
	r.result.Imported.Messages += messages
	r.result.Imported.Blobs += blobs
	if len(todos) > 0 {
		r.result.Imported.Todos++
	}
	if err := r.save(); err != nil {
		r.m.log().Warn("the import record could not be saved", "code", codeFailed)
	}
}

func contains(list []string, value string) bool { return slices.Contains(list, value) }
