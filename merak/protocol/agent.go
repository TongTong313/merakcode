package protocol

import (
	"github.com/TongTong313/merakcode/merak/engine/agent"
	"github.com/TongTong313/merakcode/merak/engine/event"
)

type AgentListParams struct {
	// Directory adds the agents that this folder and the user's root define in files.
	Directory string `json:"directory,omitempty"`
}

type AgentDeleteParams struct {
	Agent event.ID `json:"agent"`
}

type AgentSaveParams struct {
	Agent agent.Agent `json:"agent"`
}
