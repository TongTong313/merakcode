package server

import (
	"context"

	"github.com/TongTong313/merakcode/merak/protocol"
)

func (s *Server) cloudMethods() map[string]handler {
	return map[string]handler{
		"cloud.login": run(func(ctx context.Context, _ *connection, params protocol.CloudLoginParams) (any, error) {
			return s.loginCloud(ctx, params)
		}),
		"cloud.logout": run(func(ctx context.Context, _ *connection, _ struct{}) (any, error) {
			return done(s.logoutCloud(ctx))
		}),
		"cloud.status": run(func(_ context.Context, _ *connection, _ struct{}) (any, error) {
			return s.engine.CloudStatus(), nil
		}),
		"cloud.members": run(func(ctx context.Context, _ *connection, _ struct{}) (any, error) {
			return s.engine.CloudMembers(ctx)
		}),
		"remote.connect": run(func(ctx context.Context, _ *connection, params protocol.RemoteConnectParams) (any, error) {
			return s.engine.ConnectRemote(ctx, params)
		}),
		"remote.members": run(func(ctx context.Context, _ *connection, _ struct{}) (any, error) {
			return s.engine.RemoteMembers(ctx)
		}),
		"remote.start": run(func(_ context.Context, c *connection, params protocol.RemoteStartParams) (any, error) {
			return c.remote.start(params)
		}),
		"remote.deliver": run(func(_ context.Context, c *connection, params protocol.RemoteDeliveryParams) (any, error) {
			return c.remote.deliver(params)
		}),
		"remote.sync": run(func(_ context.Context, c *connection, params protocol.RemoteSyncParams) (any, error) {
			return done(c.remote.sync(params))
		}),
		"remote.control": run(func(_ context.Context, c *connection, params protocol.RemoteControlParams) (any, error) {
			return done(c.remote.control(params))
		}),
	}
}
