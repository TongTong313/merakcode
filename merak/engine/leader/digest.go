package leader

import (
	"fmt"
	"strings"
	"time"

	"github.com/TongTong313/merakcode/merak/engine/event"
	"github.com/TongTong313/merakcode/merak/engine/loop"
	"github.com/TongTong313/merakcode/merak/engine/model"
)

// Digest preserves event references while combining a human's queued message burst.
type Digest struct {
	State *State
	Focus event.ID
}

func (d Digest) Inputs(batch []event.Event) []loop.Input {
	var inputs []loop.Input
	for i := 0; i < len(batch); {
		first := batch[i]
		var text strings.Builder
		fmt.Fprintf(&text, "Event %s (%s):\n%s", first.ID, first.Type, first.Payload)
		if first.Scope.Task != "" && (first.Type == "file.changed" || first.Type == "repo.changed") {
			text.WriteString("\nPotential conflict: external changes touch this active task's scope.")
		}
		i++
		for first.Type == "human.said" && i < len(batch) {
			next := batch[i]
			elapsed := next.Time.Sub(first.Time)
			if next.Type != first.Type || next.Actor != first.Actor || next.Scope.Task != first.Scope.Task || elapsed < 0 || elapsed > 2*time.Second {
				break
			}
			fmt.Fprintf(&text, "\nEvent %s (%s):\n%s", next.ID, next.Type, next.Payload)
			i++
		}
		inputs = append(inputs, loop.Input{Actor: first.Actor, Cause: first.ID, Parts: []model.Part{{Text: text.String()}}})
	}
	return inputs
}

func (d Digest) Render(batch []event.Event) loop.Input {
	var text strings.Builder
	if d.State != nil {
		text.WriteString(d.State.Render(4096, d.Focus))
		text.WriteByte('\n')
	}
	var input loop.Input
	for _, item := range d.Inputs(batch) {
		if input.Cause == "" {
			input.Cause, input.Actor = item.Cause, item.Actor
		}
		if len(input.Parts) > 0 {
			text.WriteByte('\n')
		}
		text.WriteString(item.Parts[0].Text)
		input.Parts = []model.Part{{Text: text.String()}}
	}
	return input
}
