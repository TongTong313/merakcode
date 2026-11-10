package window

import (
	"encoding/json"

	"github.com/TongTong313/merakcode/merak/engine/event"
	"github.com/TongTong313/merakcode/merak/engine/memory"
	"github.com/TongTong313/merakcode/merak/engine/task"
)

type Excerpt struct {
	ID    event.ID    `json:"id"`
	Actor event.Actor `json:"actor"`
	Text  string      `json:"text"`
}

type ReportRef struct {
	Ref    string       `json:"ref"`
	Report *task.Report `json:"report,omitempty"`
}

type DocRef struct {
	Key   string `json:"key"`
	Title string `json:"title"`
}

// Packet keeps fixed task details and trims optional material in priority order.
type Packet struct {
	Task        task.Card     `json:"task"`
	Claim       task.Claim    `json:"claim"`
	Goal        string        `json:"goal"`
	Dialogue    []Excerpt     `json:"dialogue,omitempty"`
	Memory      []memory.Note `json:"memory,omitempty"`
	Docs        []DocRef      `json:"docs,omitempty"`
	Inputs      []ReportRef   `json:"inputs,omitempty"`
	Instruction string        `json:"instruction,omitempty"`
}

func packetTokens(value any) int {
	body, _ := json.Marshal(value)
	return EstimateText(string(body))
}

// Render trims optional fields in place before encoding the delivered packet.
func (p *Packet) Render(budget int) (string, error) {
	p.Inputs = append([]ReportRef(nil), p.Inputs...)
	for len(p.Dialogue) > 0 && packetTokens(p.Dialogue) > budget/4 {
		p.Dialogue = p.Dialogue[1:]
	}
	for len(p.Memory) > 0 && packetTokens(p.Memory) > budget*15/100 {
		p.Memory = p.Memory[:len(p.Memory)-1]
	}
	for i := range p.Inputs {
		if packetTokens(p.Inputs) <= budget/5 {
			break
		}
		p.Inputs[i].Report = nil
	}
	for packetTokens(p) > budget {
		if len(p.Dialogue) > 0 {
			p.Dialogue = p.Dialogue[1:]
			continue
		}
		if len(p.Memory) > 0 {
			p.Memory = p.Memory[:len(p.Memory)-1]
			continue
		}
		trimmed := false
		for i := range p.Inputs {
			if p.Inputs[i].Report != nil {
				p.Inputs[i].Report = nil
				trimmed = true
				break
			}
		}
		if !trimmed {
			break
		}
	}
	body, err := json.Marshal(p)
	return string(body), err
}
