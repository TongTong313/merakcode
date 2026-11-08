package protocol

import (
	"encoding/json"

	"github.com/TongTong313/merakcode/merak/engine/event"
)

type EventEmitParams struct {
	Group   event.ID        `json:"group"`
	Type    event.Type      `json:"type"`
	Payload json.RawMessage `json:"payload"`
}
