package group

import "github.com/TongTong313/merakcode/merak/engine/event"

const NoticeSent event.Type = "notice.sent"

type Notice struct {
	Kind string     `json:"kind"`
	Text string     `json:"text"`
	To   []event.ID `json:"to"`
}

func init() { event.Register[Notice](NoticeSent) }
