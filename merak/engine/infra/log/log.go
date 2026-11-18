// Package log attaches scope fields to structured diagnostics.
package log

import (
	"log/slog"

	"github.com/TongTong313/merakcode/merak/engine/infra/event"
)

func With(logger *slog.Logger, scope event.Scope) *slog.Logger {
	return logger.With("session", string(scope.Session), "group", string(scope.Group), "task", string(scope.Task))
}
