// Package agent contains what defines an agent: its role, model, tools and the product that runs it.
package agent

import (
	"github.com/TongTong313/merakcode/merak/engine/event"
	"github.com/TongTong313/merakcode/merak/engine/memory"
	"github.com/TongTong313/merakcode/merak/engine/model"
	"github.com/TongTong313/merakcode/merak/engine/permission"
	"github.com/TongTong313/merakcode/merak/engine/session"
	"github.com/TongTong313/merakcode/merak/engine/worker"
)

type Role string

const (
	Leader Role = "leader"
	Worker Role = "worker"
)

type ModelRef struct {
	Provider string         `json:"provider"`
	Model    string         `json:"model"`
	Thinking model.Thinking `json:"thinking,omitempty"`
}
type Product struct {
	Remote *RemoteSource     `json:"remote,omitempty"`
	Kind   worker.Kind       `json:"kind"`
	Binary string            `json:"binary"`
	Args   []string          `json:"args,omitempty"`
	Env    map[string]string `json:"env,omitempty"`
	Model  string            `json:"model,omitempty"`
}

type RemoteSource struct {
	Connection event.ID    `json:"connection"`
	Group      event.ID    `json:"group"`
	Member     event.ID    `json:"member"`
	Caps       worker.Caps `json:"caps"`
}
type Agent struct {
	Shared bool `json:"shared,omitempty"`
	// Disabled turns the agent off: it starts no conversation, continues none and takes no seat in a group.
	Disabled bool            `json:"disabled,omitempty"`
	Memory   []memory.Scope  `json:"memory,omitzero"`
	Budget   Budget          `json:"budget,omitempty"`
	Network  []string        `json:"network,omitempty"`
	Mode     permission.Mode `json:"mode,omitempty"`
	ID       event.ID        `json:"id"`
	Name     string          `json:"name"`
	Role     Role            `json:"role"`
	Summary  string          `json:"summary"`
	Duties   string          `json:"duties"`
	System   string          `json:"system,omitempty"`
	Model    ModelRef        `json:"model"`
	ToolPool string          `json:"toolPool"`
	Product  *Product        `json:"product,omitempty"`
	// Tools limits a child started from this agent to these tools; empty means the pool of its kind.
	Tools []string `json:"tools,omitempty"`
	// Switches turn tools off or on by name for conversations with this agent; a name may end in *.
	Switches map[string]bool `json:"switches,omitempty"`
	// Source is "file" or "config" for an agent that is defined outside the library; it is read-only.
	Source string `json:"source,omitempty"`
}

type Budget = session.Budget

func DefaultLeader() Agent {
	return Agent{Name: "Leader", Role: Leader, Summary: "Coordinate work and report outcomes.", ToolPool: "leader.default", Shared: true}
}
func DefaultWorker() Agent {
	return Agent{Name: "Worker", Role: Worker, Summary: "Implement and verify assigned work.", ToolPool: "worker.default", Shared: true}
}
