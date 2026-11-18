package protocol

import "github.com/TongTong313/merakcode/merak/engine/infra/event"

type ScheduleDeleteParams struct {
	ID event.ID `json:"id"`
}
