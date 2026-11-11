package task

import (
	"context"
	"strings"

	"github.com/TongTong313/merakcode/merak/engine/event"
	"github.com/TongTong313/merakcode/merak/engine/store"
)

// Rework returns a reported claim to its member's queue without replacing its resources.
func (p *Pool) Rework(ctx context.Context, id event.ID, feedback string) error {
	p.mu.Lock()
	defer p.mu.Unlock()
	if err := p.load(ctx); err != nil {
		return err
	}
	card, index, ok := p.claim(id)
	if !ok {
		return store.ErrNotFound
	}
	if card.Claims[index].Status != ClaimReported && card.Claims[index].Status != ClaimInterrupted || card.Claims[index].Integrated != "" || strings.TrimSpace(feedback) == "" {
		return ErrState
	}
	card = clone(card)
	claim := &card.Claims[index]
	claim.Status, claim.Report, claim.Feedback = ClaimQueued, nil, feedback
	card.LastReview = nil
	if card.Status == Blocked {
		card.PreviousStatus = claimStatus(card.Claims)
	} else {
		card.Status = claimStatus(card.Claims)
	}
	return p.emit(ctx, Updated, card, p.leaderActor(ctx, card))
}
