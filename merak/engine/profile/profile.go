// Package profile contains the configuration shared by worker runners.
package profile

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
type Profile struct {
	Shared   bool            `json:"shared,omitempty"`
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
}

type Budget = session.Budget

func DefaultLeader() Profile {
	return Profile{Name: "Leader", Role: Leader, Summary: "Coordinate work and report outcomes.", ToolPool: "leader.default", Shared: true}
}
func DefaultWorker() Profile {
	return Profile{Name: "Worker", Role: Worker, Summary: "Implement and verify assigned work.", ToolPool: "worker.default", Shared: true}
}
