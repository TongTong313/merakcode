package protocol

import (
	"github.com/TongTong313/merakcode/merak/engine/agent"
	"github.com/TongTong313/merakcode/merak/engine/event"
)

type AgentListParams struct {
}

type AgentDeleteParams struct {
	Agent event.ID `json:"agent"`
}

type AgentSaveParams struct {
	Agent agent.Agent `json:"agent"`
}
