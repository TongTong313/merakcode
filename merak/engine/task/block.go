package task

import (
	"context"

	"github.com/TongTong313/merakcode/merak/engine/event"
	"github.com/TongTong313/merakcode/merak/engine/store"
)

// Block preserves the resumable state when an engine constraint stops a task.
func (p *Pool) Block(ctx context.Context, id event.ID) error {
	p.mu.Lock()
	defer p.mu.Unlock()
	if err := p.load(ctx); err != nil {
		return err
	}
	card, ok := p.cards[id]
	if !ok {
		return store.ErrNotFound
	}
	if card.Status == Done || card.Status == Failed || card.Status == Cancelled {
		return ErrState
	}
	if card.Status == Blocked {
		return nil
	}
	card.PreviousStatus, card.Status = card.Status, Blocked
	card.PlanPending = false
	if card.Parent == "" {
		card.PreviousPhase, card.Phase = card.Phase, PhaseStalled
	}
	return p.emit(ctx, Updated, card, event.Actor{Kind: event.ActorAgent})
}
