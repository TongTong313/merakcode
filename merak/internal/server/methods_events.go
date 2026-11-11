package server

import (
	"context"

	"github.com/TongTong313/merakcode/merak/engine/event"
	"github.com/TongTong313/merakcode/merak/engine/store"
	"github.com/TongTong313/merakcode/merak/protocol"
)

func (s *Server) eventMethods() map[string]handler {
	return map[string]handler{
		"events.read": run(func(ctx context.Context, _ *connection, params protocol.EventsReadParams) (any, error) {
			return s.engine.ReadEvents(ctx, params.Stream, params.From, params.Limit)
		}),
		"events.find": run(func(ctx context.Context, _ *connection, query store.Query) (any, error) {
			return s.engine.FindEvents(ctx, query)
		}),
		"events.get": run(func(ctx context.Context, _ *connection, params protocol.EventsGetParams) (any, error) {
			return s.engine.GetEvent(ctx, params.ID)
		}),
		"event.emit": run(func(ctx context.Context, _ *connection, params protocol.EventEmitParams) (any, error) {
			return s.engine.EmitEvent(ctx, params.Group, params.Type, params.Payload)
		}),
		"events.subscribe": run(func(_ context.Context, c *connection, filter event.Filter) (any, error) {
			id := event.NewID()
			c.filterMu.Lock()
			c.filters[id] = filter
			c.filterMu.Unlock()
			return protocol.SubscribeResult{Subscription: id}, nil
		}),
		"events.unsubscribe": run(func(_ context.Context, c *connection, params protocol.UnsubscribeParams) (any, error) {
			c.filterMu.Lock()
			delete(c.filters, params.Subscription)
			c.filterMu.Unlock()
			return nil, nil
		}),
	}
}
