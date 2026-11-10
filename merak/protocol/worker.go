package protocol

import (
	"github.com/TongTong313/merakcode/merak/engine/event"
	"github.com/TongTong313/merakcode/merak/engine/profile"
)

// WorkerRunParams starts a standalone worker whose lifetime belongs to the connection.
type WorkerRunParams struct {
	Session event.ID        `json:"session"`
	Profile profile.Profile `json:"profile"`
	Workdir string          `json:"workdir"`
	Packet  string          `json:"packet"`
}
