// Package roster provides group membership, shared documents and task scope checks.
package roster

import (
	"context"
	"sync"

	"github.com/TongTong313/merakcode/merak/engine/agent/registry"
	"github.com/TongTong313/merakcode/merak/engine/collab/group"
	"github.com/TongTong313/merakcode/merak/engine/collab/task"
	"github.com/TongTong313/merakcode/merak/engine/infra/core"
	"github.com/TongTong313/merakcode/merak/engine/infra/event"
)

// Roster keeps the shared group lookup dependencies and hosting records.
type Roster struct {
	core         *core.Core
	registry     *registry.Registry
	groups       *group.Manager
	tasks        *task.Pool
	execution    Execution
	hostedGroups sync.Map
}

// Execution locates the member and project behind a running assignment.
type Execution interface {
	ExecutionSource(event.Scope, event.ID) (event.ID, event.ID)
	ExecutionProject(context.Context, event.Scope, string) (string, error)
}

// Deps supplies the existing group, task and execution services.
type Deps struct {
	Core      *core.Core
	Registry  *registry.Registry
	Groups    *group.Manager
	Tasks     *task.Pool
	Execution Execution
}

// New connects the roster to the shared engine services.
func New(d Deps) *Roster {
	return &Roster{core: d.Core, registry: d.Registry, groups: d.Groups, tasks: d.Tasks, execution: d.Execution}
}

// ExecutionSource resolves the member through the configured execution service.
func (domain *Roster) ExecutionSource(scope event.Scope, member event.ID) (event.ID, event.ID) {
	return domain.execution.ExecutionSource(scope, member)
}

// ExecutionProject resolves the project through the configured execution service.
func (domain *Roster) ExecutionProject(ctx context.Context, scope event.Scope, directory string) (string, error) {
	return domain.execution.ExecutionProject(ctx, scope, directory)
}

// HostedGroup reads the host recorded for a group.
func (domain *Roster) HostedGroup(id event.ID) (any, bool) {
	return domain.hostedGroups.Load(id)
}

// HostGroup records the host of a group.
func (domain *Roster) HostGroup(id event.ID, host string) {
	domain.hostedGroups.Store(id, host)
}
