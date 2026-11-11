package task

import (
	"context"

	"github.com/TongTong313/merakcode/merak/engine/event"
)

type Update struct {
	Budget *BudgetIncrease `json:"budget,omitempty"`
	Reason string          `json:"reason,omitempty"`
	Phase  Phase           `json:"phase,omitempty"`
}

func (p *Pool) Update(ctx context.Context, id event.ID, update Update, actor event.Actor) error {
	if update.Budget != nil {
		if update.Phase != "" {
			return ErrState
		}
		return p.increaseBudget(ctx, id, *update.Budget, actor)
	}
	if update.Phase != "" {
		return p.SetPhase(ctx, id, update.Phase, actor)
	}
	return ErrState
}
