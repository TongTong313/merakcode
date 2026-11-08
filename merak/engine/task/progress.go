package task

import "github.com/TongTong313/merakcode/merak/engine/event"

const Progressed event.Type = "task.progress"

type Progress struct {
	Claim   event.ID `json:"claim"`
	Summary string   `json:"summary"`
}

func init() { event.Register[Progress](Progressed) }
