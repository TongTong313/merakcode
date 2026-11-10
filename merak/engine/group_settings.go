package engine

import (
	"context"

	"github.com/TongTong313/merakcode/merak/engine/event"
	"github.com/TongTong313/merakcode/merak/engine/group"
	"github.com/TongTong313/merakcode/merak/engine/leader"
)

func (e *Engine) UpdateGroup(ctx context.Context, id, human event.ID, change group.Update) (group.Group, error) {
	if change.Settings != nil {
		if _, err := leader.NewTriggers(append(leader.DefaultTriggers(), change.Settings.Triggers...)); err != nil {
			return group.Group{}, err
		}
	}
	return e.Groups.Update(ctx, id, human, change)
}
