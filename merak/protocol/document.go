package protocol

import (
	"github.com/TongTong313/merakcode/merak/engine/collab/group"
	"github.com/TongTong313/merakcode/merak/engine/infra/event"
)

type DocReadParams struct {
	Group event.ID `json:"group"`
	Key   string   `json:"key"`
}

type DocWriteParams struct {
	group.Document
}
