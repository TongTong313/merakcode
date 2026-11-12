package server

import (
	"context"
	"errors"

	"github.com/TongTong313/merakcode/merak/engine"
	"github.com/TongTong313/merakcode/merak/internal/migrate"
	"github.com/TongTong313/merakcode/merak/internal/platform/errorcode"
	"github.com/TongTong313/merakcode/merak/protocol"
)

func (s *Server) importMethods() map[string]handler {
	return map[string]handler{
		"import.start": run(func(_ context.Context, _ *connection, params protocol.ImportStartParams) (any, error) {
			if params.From != migrate.From {
				return nil, &engine.Error{Code: errorcode.InvalidArguments, Err: errors.New("only v0.3 can be imported")}
			}
			if !s.migration.Found() {
				return nil, &engine.Error{Code: errorcode.ImportSourceNotFound, Err: errors.New("data/merakcode.db was not found")}
			}
			return protocol.ImportStartResult{Started: s.migration.Start()}, nil
		}),
		"import.status": run(func(context.Context, *connection, struct{}) (any, error) {
			return s.migration.Status(), nil
		}),
	}
}
