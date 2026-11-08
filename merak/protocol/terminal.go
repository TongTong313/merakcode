package protocol

import (
	"github.com/TongTong313/merakcode/merak/engine/event"
	"github.com/TongTong313/merakcode/merak/engine/terminal"
)

type TerminalIDParams struct {
	ID event.ID `json:"id"`
}
type TerminalUpdateParams struct {
	TerminalIDParams
	terminal.UpdateOptions
}
