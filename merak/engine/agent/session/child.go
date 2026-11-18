package session

import (
	"github.com/TongTong313/merakcode/merak/engine/agent/model"
	"github.com/TongTong313/merakcode/merak/engine/infra/event"
)

const ChildStarted event.Type = "child.started"
const ChildFinished event.Type = "child.finished"

type ChildResult struct {
	ID     event.ID     `json:"id"`
	Report []model.Part `json:"report,omitempty"`
	Stop   string       `json:"stop,omitempty"`
	Code   string       `json:"code,omitempty"`
}

type ChildState struct {
	ID        event.ID `json:"id"`
	Delivered bool     `json:"delivered"`
}

func init() {
	event.Register[ChildResult](ChildStarted)
	event.Register[ChildResult](ChildFinished)
}
