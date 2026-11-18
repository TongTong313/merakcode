package protocol

import (
	"github.com/TongTong313/merakcode/merak/engine/infra/event"
)

type EventsGetParams struct {
	ID event.ID `json:"id"`
}
