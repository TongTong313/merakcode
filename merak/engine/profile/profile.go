// Package profile contains the configuration shared by worker runners.
package profile

import (
	"github.com/TongTong313/merakcode/merak/engine/event"
	"github.com/TongTong313/merakcode/merak/engine/model"
	"github.com/TongTong313/merakcode/merak/engine/permission"
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
	Kind   worker.Kind       `json:"kind"`
	Binary string            `json:"binary"`
	Args   []string          `json:"args,omitempty"`
	Env    map[string]string `json:"env,omitempty"`
	Model  string            `json:"model,omitempty"`
}
type Profile struct {
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

func DefaultLeader() Profile {
	return Profile{Name: "Leader", Role: Leader, Summary: "Coordinate work and report outcomes.", ToolPool: "leader.default"}
}
func DefaultWorker() Profile {
	return Profile{Name: "Worker", Role: Worker, Summary: "Implement and verify assigned work.", ToolPool: "worker.default"}
}
