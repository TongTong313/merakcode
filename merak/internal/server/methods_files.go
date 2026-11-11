package server

import (
	"context"

	"github.com/TongTong313/merakcode/merak/engine/terminal"
	"github.com/TongTong313/merakcode/merak/protocol"
)

func (s *Server) fileMethods() map[string]handler {
	return map[string]handler{
		"file.read": run(func(ctx context.Context, _ *connection, params protocol.FileParams) (any, error) {
			return s.engine.ReadFile(ctx, params.Directory, params.Path)
		}),
		"file.list": run(func(ctx context.Context, _ *connection, params protocol.FileParams) (any, error) {
			return s.engine.ListFiles(ctx, params.Directory, params.Path)
		}),
		"repo.status": run(func(ctx context.Context, _ *connection, params protocol.DirectoryParams) (any, error) {
			return s.engine.RepoStatus(ctx, params.Directory)
		}),
		"repo.branches": run(func(ctx context.Context, _ *connection, params protocol.DirectoryParams) (any, error) {
			return s.engine.RepoBranches(ctx, params.Directory)
		}),
		"repo.diff": run(func(ctx context.Context, _ *connection, params protocol.RepoDiffParams) (any, error) {
			return s.engine.RepoDiff(ctx, params.Directory, params.Base, params.Session)
		}),
		"repo.checkout": run(func(ctx context.Context, _ *connection, params protocol.RepoCheckoutParams) (any, error) {
			return done(s.engine.RepoCheckout(ctx, params.Directory, params.Branch))
		}),
		"terminal.list": run(func(_ context.Context, _ *connection, params protocol.DirectoryParams) (any, error) {
			return s.engine.Terminals.List(params.Directory), nil
		}),
		"terminal.create": run(func(ctx context.Context, _ *connection, params terminal.CreateOptions) (any, error) {
			return s.engine.Terminals.Create(ctx, params)
		}),
		"terminal.get": run(func(_ context.Context, _ *connection, params protocol.TerminalIDParams) (any, error) {
			return s.engine.Terminals.Get(params.ID)
		}),
		"terminal.remove": run(func(ctx context.Context, _ *connection, params protocol.TerminalIDParams) (any, error) {
			return done(s.engine.Terminals.Remove(ctx, params.ID))
		}),
		"terminal.update": run(func(ctx context.Context, _ *connection, params protocol.TerminalUpdateParams) (any, error) {
			return s.engine.Terminals.Update(ctx, params.ID, params.UpdateOptions)
		}),
		"blob.read": run(func(ctx context.Context, _ *connection, params protocol.BlobReadParams) (any, error) {
			data, total, err := s.engine.ReadBlob(ctx, params.Ref, params.Offset, params.Limit)
			return protocol.BlobReadResult{Data: data, Total: total, Offset: params.Offset}, err
		}),
	}
}
