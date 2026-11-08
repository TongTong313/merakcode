package group

import "github.com/TongTong313/merakcode/merak/engine/event"

const HumanSaid event.Type = "human.said"

type Message struct {
	Text string     `json:"text"`
	To   []event.ID `json:"to,omitempty"`
}

func init() { event.Register[Message](HumanSaid) }
