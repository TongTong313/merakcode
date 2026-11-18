package enginetest

import (
	"github.com/TongTong313/merakcode/merak/engine/infra/event"
)

func TurnFilter(session event.ID) event.Filter {
	return event.Filter{Scope: event.Scope{Session: session}, Types: []event.Type{"turn.finished"}}
}
