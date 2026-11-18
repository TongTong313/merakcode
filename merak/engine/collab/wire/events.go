package wire

import (
	"github.com/TongTong313/merakcode/merak/engine/infra/event"
)

type EventsReadParams struct {
	Stream event.Stream `json:"stream"`
	From   uint64       `json:"from"`
	Limit  int          `json:"limit,omitempty"`
}
