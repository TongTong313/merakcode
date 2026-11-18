package protocol

import (
	"github.com/TongTong313/merakcode/merak/engine/feature/terminal"
	"github.com/TongTong313/merakcode/merak/engine/infra/event"
)

type TerminalIDParams struct {
	ID event.ID `json:"id"`
}
type TerminalUpdateParams struct {
	TerminalIDParams
	terminal.UpdateOptions
}
