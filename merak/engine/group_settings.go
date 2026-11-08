package engine

import (
	"context"

	"github.com/TongTong313/merakcode/merak/engine/event"
	"github.com/TongTong313/merakcode/merak/engine/group"
	"github.com/TongTong313/merakcode/merak/engine/leader"
)

func (e *Engine) UpdateGroupSettings(ctx context.Context, id, human event.ID, settings group.Settings) (group.Group, error) {
	if _, err := leader.NewTriggers(append(leader.DefaultTriggers(), settings.Triggers...)); err != nil {
		return group.Group{}, err
	}
	return e.Groups.UpdateSettings(ctx, id, human, settings)
}
