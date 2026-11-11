package protocol

import "github.com/TongTong313/merakcode/merak/engine/event"

type ScheduleDeleteParams struct {
	ID event.ID `json:"id"`
}
