package server

import (
	"context"
	"errors"

	"github.com/TongTong313/merakcode/merak/internal/platform/config"
	"github.com/TongTong313/merakcode/merak/protocol"
)

func (s *Server) configMethods() map[string]handler {
	return map[string]handler{
		"config.get": run(func(_ context.Context, _ *connection, _ struct{}) (any, error) {
			return s.configuration(), nil
		}),
		"config.set": run(func(_ context.Context, _ *connection, patch config.Patch) (any, error) {
			return s.configure(patch)
		}),
		"model.list": run(func(_ context.Context, _ *connection, params protocol.ModelListParams) (any, error) {
			for _, o := range params.Overrides {
				if o.Provider == "" || o.ID == "" || o.Window != nil && *o.Window <= 0 || o.MaxOutput != nil && *o.MaxOutput <= 0 {
					return nil, errors.New("invalid model override")
				}
			}
			return s.engine.ModelCatalog(params.Overrides...), nil
		}),
		"model.discover": run(func(ctx context.Context, _ *connection, params protocol.ModelDiscoverParams) (any, error) {
			return discoverModels(ctx, params.Provider)
		}),
		"model.refresh": run(func(ctx context.Context, _ *connection, params protocol.ModelRefreshParams) (any, error) {
			if err := s.engine.RefreshModels(ctx, params.Provider); err != nil {
				return nil, err
			}
			return s.engine.ModelCatalog(), nil
		}),
		"diagnostics.bundle": run(func(ctx context.Context, _ *connection, params protocol.DiagnosticsParams) (any, error) {
			return s.diagnostics(ctx, params)
		}),
	}
}
