package engine

import (
	"context"

	"github.com/TongTong313/merakcode/merak/engine/event"
	"github.com/TongTong313/merakcode/merak/engine/group"
	"github.com/TongTong313/merakcode/merak/engine/loop"
	"github.com/TongTong313/merakcode/merak/engine/model"
	"github.com/TongTong313/merakcode/merak/engine/task"
)

func (e *Engine) controlGroupClaims(ctx context.Context, run *groupRun, fact event.Event, thread event.ID) {
	cards, err := e.Tasks.List(ctx, run.group.ID)
	if err != nil {
		return
	}
	for _, card := range cards {
		if thread != "" && thread != run.group.ID {
			root, err := e.taskRoot(ctx, card)
			if err != nil || root != thread {
				continue
			}
		}
		for _, claim := range card.Claims {
			if fact.Type == group.Resumed && claim.Status == task.ClaimQueued {
				e.startMember(run, claim.Member)
			}
			if fact.Type != group.Paused || claim.Status != task.ClaimActive {
				continue
			}
			e.mu.Lock()
			active, ok := e.claimRuns[claim.ID]
			if !ok && e.claimPreparing[claim.ID] != nil {
				e.claimPreparing[claim.ID].cancel()
			}
			e.mu.Unlock()
			if !ok {
				continue
			}
			input := loop.Input{Actor: fact.Actor, Cause: fact.ID, Parts: []model.Part{{Text: "Pause requested. Stop work safely and submit a blocked report describing your current progress."}}}
			if !active.caps.Steer || active.run.Send(ctx, input) != nil {
				_ = active.run.Cancel(ctx)
			}
		}
	}
}
