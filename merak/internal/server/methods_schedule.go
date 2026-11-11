package server

import (
	"context"

	"github.com/TongTong313/merakcode/merak/protocol"
)

func (s *Server) scheduleMethods() map[string]handler {
	return map[string]handler{
		"schedule.list": run(func(ctx context.Context, _ *connection, _ struct{}) (any, error) {
			return s.engine.ListSchedules(ctx)
		}),
		"schedule.delete": run(func(ctx context.Context, _ *connection, params protocol.ScheduleDeleteParams) (any, error) {
			return done(s.engine.DeleteSchedule(ctx, params.ID))
		}),
	}
}
