package group

import "github.com/TongTong313/merakcode/merak/engine/event"

type DocumentInfo struct {
	Group event.ID `json:"group"`
	Key   string   `json:"key"`
	Title string   `json:"title"`
	Rev   uint64   `json:"rev"`
}

type Document struct {
	DocumentInfo
	Text string `json:"text"`
}
