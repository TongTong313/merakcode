// Package question defines a question addressed to a human and its answer.
package question

import "github.com/TongTong313/merakcode/merak/engine/event"

const Asked event.Type = "question.asked"
const Answered event.Type = "question.answered"

type Request struct {
	To      event.ID `json:"to,omitempty"`
	ID      event.ID `json:"-"`
	Text    string   `json:"text"`
	Options []string `json:"options,omitempty"`
}

type Answer struct {
	Human     event.ID `json:"human,omitempty"`
	Text      string   `json:"text,omitempty"`
	Cancelled bool     `json:"cancelled,omitempty"`
}

func init() {
	event.Register[Request](Asked)
	event.Register[Answer](Answered)
}
