// Package conversation owns sessions and runs their dialogue turns.
package conversation

import (
	"context"
	"sync"
	"sync/atomic"
	"time"

	"github.com/TongTong313/merakcode/merak/engine/agent/definition"
	"github.com/TongTong313/merakcode/merak/engine/agent/loop"
	"github.com/TongTong313/merakcode/merak/engine/agent/memory"
	"github.com/TongTong313/merakcode/merak/engine/agent/model"
	"github.com/TongTong313/merakcode/merak/engine/agent/model/catalog"
	"github.com/TongTong313/merakcode/merak/engine/agent/permission"
	"github.com/TongTong313/merakcode/merak/engine/agent/registry"
	"github.com/TongTong313/merakcode/merak/engine/agent/session"
	"github.com/TongTong313/merakcode/merak/engine/agent/tool"
	"github.com/TongTong313/merakcode/merak/engine/agent/window"
	"github.com/TongTong313/merakcode/merak/engine/infra/config"
	"github.com/TongTong313/merakcode/merak/engine/infra/core"
	"github.com/TongTong313/merakcode/merak/engine/infra/event"
)

// Deps supplies the shared conversation services and higher-level callbacks.
type Deps struct {
	Core          *core.Core
	Registry      *registry.Registry
	Manager       *session.Manager
	Catalog       *catalog.Catalog
	Notes         *memory.Repository
	Gate          *permission.Gate
	AskPermission func(context.Context, permission.Request) (permission.Reply, error)
	Model         string
	Thinking      model.Thinking
	System        string
	Tools         *tool.Pool
	MemoryIdle    time.Duration
	Hooks         Hooks
}

// Manager owns live conversations and their shared configuration.
type Manager struct {
	core              *core.Core
	registry          *registry.Registry
	manager           *session.Manager
	catalog           *catalog.Catalog
	notes             *memory.Repository
	gate              *permission.Gate
	askPermission     func(context.Context, permission.Request) (permission.Reply, error)
	model             string
	thinking          model.Thinking
	system            string
	tools             *tool.Pool
	hooks             Hooks
	mu                sync.Mutex
	sessions          map[event.ID]*Conversation
	keyMu             sync.Mutex
	counter           *window.Counter
	localHuman        event.ID
	memoryModel       atomic.Pointer[definition.ModelRef]
	memoryIdle        time.Duration
	memoryExtractions sync.Map
	memoryExtractOff  atomic.Bool
	memoryRecallOff   atomic.Bool
	workspacePending  map[config.Trust]bool
	workspaceMu       sync.Mutex
	autoCompactOff    atomic.Bool
}

// New creates a conversation manager before the engine starts its background work.
func New(d Deps) *Manager {
	domain := &Manager{
		core: d.Core, registry: d.Registry, manager: d.Manager, catalog: d.Catalog,
		notes: d.Notes, gate: d.Gate, askPermission: d.AskPermission,
		model: d.Model, thinking: d.Thinking, system: d.System, tools: d.Tools,
		hooks: d.Hooks, memoryIdle: d.MemoryIdle,
		counter: new(window.Counter), sessions: make(map[event.ID]*Conversation),
	}
	if domain.memoryIdle <= 0 {
		domain.memoryIdle = 30 * time.Second
	}
	return domain
}

// LocalHuman returns the configured local user.
func (domain *Manager) LocalHuman() event.ID { return domain.localHuman }

// SetAutoCompact applies the context-compaction switch for future turns.
func (domain *Manager) SetAutoCompact(enabled bool) { domain.autoCompactOff.Store(!enabled) }

// Hooks connects the existing higher-level operations at their original call sites.
type Hooks struct {
	External    External
	Stop        []func(event.ID) bool
	Environment func(context.Context, *session.State, *tool.Env) error
	Project     func(context.Context, event.Scope, string) (string, error)
	Children    func(context.Context, ChildRun) Children
	ChildAgent  func(context.Context) string
	Pending     func(context.Context) ([]event.Event, error)
	Loop        []func(LoopStage, *session.State, *loop.Loop)
	// Input receives both the original input and the parts with recalled notes and the current date.
	Input []func(context.Context, *Conversation, loop.Input, []model.Part, bool) ([]model.Part, error)
	// BeforeTurn returns the result handler that runs immediately after RunTurn, before logging.
	BeforeTurn []func(context.Context, *Conversation) (func(loop.Outcome), error)
	// AfterTurn keeps the checkpoint and lifetime cleanup at their separate original positions.
	// The session ID is captured when cleanup is deferred, before creation can replace the state with nil.
	AfterTurn []func(context.Context, *Conversation, event.ID, EndStage) error
	Cancelled []func(context.Context, event.ID)
	Deleted   []func(context.Context, event.ID)
}

// LoopStage keeps tool registration before restoring tools and tracking after it.
type LoopStage uint8

const (
	LoopTools LoopStage = iota
	LoopTrack
)

// EndStage distinguishes a turn checkpoint from the end of a conversation's lifetime.
type EndStage uint8

const (
	Snapshot EndStage = iota
	Close
)

// ChildRun executes one child session and returns its outcome.
type ChildRun = func(context.Context, event.ID, string) (loop.Outcome, error)

// Children is what a conversation needs from its background child runner.
type Children interface {
	tool.Children
	tool.AgentChildren
	loop.Steer
	Ready() <-chan struct{}
	SetRun(ChildRun)
	Cancel()
	Close()
}

// External handles conversations run by an external product.
type External interface {
	Create(context.Context, definition.Agent, SessionOptions) (event.ID, error)
	Send(context.Context, event.ID, []model.Part) (bool, error)
}
