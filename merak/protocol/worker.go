package protocol

import (
	"github.com/TongTong313/merakcode/merak/engine/agent"
	"github.com/TongTong313/merakcode/merak/engine/event"
)

// WorkerRunParams starts a standalone worker whose lifetime belongs to the connection.
type WorkerRunParams struct {
	Session event.ID    `json:"session"`
	Profile agent.Agent `json:"profile"`
	Workdir string      `json:"workdir"`
	Packet  string      `json:"packet"`
}
