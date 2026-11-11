package protocol

import (
	"github.com/TongTong313/merakcode/merak/engine/event"
	"github.com/TongTong313/merakcode/merak/engine/group"
)

type DocReadParams struct {
	Group event.ID `json:"group"`
	Key   string   `json:"key"`
}

type DocWriteParams struct {
	group.Document
}
