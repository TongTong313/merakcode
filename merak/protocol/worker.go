package protocol

import (
	"github.com/TongTong313/merakcode/merak/engine/agent/definition"
	"github.com/TongTong313/merakcode/merak/engine/infra/event"
)

// WorkerRunParams starts a standalone worker whose lifetime belongs to the connection.
type WorkerRunParams struct {
	Session event.ID         `json:"session"`
	Profile definition.Agent `json:"profile"`
	Workdir string           `json:"workdir"`
	Packet  string           `json:"packet"`
}
