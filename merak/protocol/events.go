package protocol

import "github.com/TongTong313/merakcode/merak/engine/event"

type EventsReadParams struct {
	Stream event.Stream `json:"stream"`
	From   uint64       `json:"from"`
	Limit  int          `json:"limit,omitempty"`
}

type EventsGetParams struct {
	ID event.ID `json:"id"`
}
