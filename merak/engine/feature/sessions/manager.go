// Package sessions owns conversation plans, schedules, commands, snapshots and imports.
package sessions

import (
	"sync"
	"sync/atomic"
	"time"

	"github.com/TongTong313/merakcode/merak/engine/agent/conversation"
	"github.com/TongTong313/merakcode/merak/engine/agent/memory"
	"github.com/TongTong313/merakcode/merak/engine/agent/permission"
	"github.com/TongTong313/merakcode/merak/engine/agent/registry"
	"github.com/TongTong313/merakcode/merak/engine/agent/session"
	"github.com/TongTong313/merakcode/merak/engine/agent/tool"
	"github.com/TongTong313/merakcode/merak/engine/collab/remote"
	"github.com/TongTong313/merakcode/merak/engine/collab/roster"
	slash "github.com/TongTong313/merakcode/merak/engine/feature/command"
	"github.com/TongTong313/merakcode/merak/engine/feature/plan"
	"github.com/TongTong313/merakcode/merak/engine/feature/schedule"
	"github.com/TongTong313/merakcode/merak/engine/infra/core"
)

// Deps supplies the existing shared objects used by session features.
type Deps struct {
	Core         *core.Core
	Registry     *registry.Registry
	Conversation *conversation.Manager
	Roster       *roster.Roster
	Remote       *remote.Remote
	Manager      *session.Manager
	Notes        *memory.Repository
	Tools        *tool.Pool
	Gate         *permission.Gate
	Snapshots    string
}

// New initializes the existing Sessions object before its registered callbacks can run.
func New(target *Sessions, d Deps) *Sessions {
	target.core = d.Core
	target.registry = d.Registry
	target.conversation = d.Conversation
	target.roster = d.Roster
	target.remote = d.Remote
	target.manager = d.Manager
	target.notes = d.Notes
	target.tools = d.Tools
	target.gate = d.Gate
	target.snapshotDir = d.Snapshots
	target.plans = plan.New(d.Core.Store)
	return target
}

// StartSchedules initializes scheduled tasks before starting their original watcher.
func (e *Sessions) StartSchedules(every time.Duration) {
	e.schedules = schedule.Schedules{Docs: e.core.Store}
	e.scheduleRunner = &schedule.Runner{Schedules: e.schedules, Now: e.core.Now, Fire: e.fireSchedule, Missed: e.missedSchedule}
	e.core.Workers.Go(func() { e.watchSchedules(every) })
}

// Sessions owns the mutable state used by conversation features.
type Sessions struct {
	core             *core.Core
	registry         *registry.Registry
	conversation     *conversation.Manager
	roster           *roster.Roster
	remote           *remote.Remote
	manager          *session.Manager
	notes            *memory.Repository
	tools            *tool.Pool
	gate             *permission.Gate
	plans            *plan.Plans
	commandSet       atomic.Pointer[map[string]slash.Entry]
	snapshotDir      string
	snapshotsOff     atomic.Bool
	retentionDays    atomic.Int64
	schedules        schedule.Schedules
	scheduleRunner   *schedule.Runner
	scheduleNoticeMu sync.Mutex
}

// SessionSettings are the configuration keys that decide what a conversation keeps.
type SessionSettings struct {
	// Snapshot records the files of a conversation so a revert can put them back.
	Snapshot bool
	// AutoCompact lets a conversation shrink its own context when it fills up.
	AutoCompact bool
	// RetentionDays deletes conversations idle for that many days; 0 keeps them.
	RetentionDays int
}
