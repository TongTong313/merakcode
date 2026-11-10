package task

import (
	"context"

	"github.com/TongTong313/merakcode/merak/engine/event"
)

// RemoveMember serializes removal with assignment so queued work cannot lose its member.
func (p *Pool) RemoveMember(ctx context.Context, groupID, human, member event.ID) error {
	p.mu.Lock()
	defer p.mu.Unlock()
	if err := p.load(ctx); err != nil {
		return err
	}
	for _, card := range p.cards {
		if card.Group != groupID || card.Status == Done || card.Status == Cancelled || card.Status == Failed {
			continue
		}
		if card.Leader == member {
			return ErrBusy
		}
		for _, claim := range card.Claims {
			if claim.Member == member && (claim.Status == ClaimActive || claim.Status == ClaimQueued) {
				return ErrBusy
			}
		}
	}
	return p.groups.RemoveMember(ctx, groupID, human, member)
}
