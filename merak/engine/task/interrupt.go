package task

import (
	"context"
	"github.com/TongTong313/merakcode/merak/engine/event"
	"github.com/TongTong313/merakcode/merak/engine/store"
)

// Interrupt preserves the session and workspace for an explicit retry.
func (p *Pool) Interrupt(ctx context.Context, id event.ID) error {
	p.mu.Lock()
	defer p.mu.Unlock()
	if err := p.load(ctx); err != nil {
		return err
	}
	card, index, ok := p.claim(id)
	if !ok {
		return store.ErrNotFound
	}
	if card.Claims[index].Status == ClaimInterrupted {
		return nil
	}
	if card.Claims[index].Status != ClaimActive {
		return ErrState
	}
	card = clone(card)
	card.Claims[index].Status = ClaimInterrupted
	card.PreviousStatus = claimStatus(card.Claims)
	card.Status, card.PlanPending = Blocked, false
	if card.Parent == "" && card.Phase != PhaseStalled {
		card.PreviousPhase, card.Phase = card.Phase, PhaseStalled
	}
	return p.emit(ctx, Updated, card, event.Actor{Kind: "system"})
}
