// Package core holds the shared dependencies of the engine's domains.
package core

import (
	"context"
	"log/slog"
	"sync"
	"time"

	"github.com/TongTong313/merakcode/merak/engine/infra/event"
	"github.com/TongTong313/merakcode/merak/engine/infra/store"
)

// Core shares the engine's store, event bus, clock and lifecycle with its domains.
type Core struct {
	Store   store.Store
	Now     func() time.Time
	NewID   func() event.ID
	Ctx     context.Context
	Bus     *event.Bus
	Logger  *slog.Logger
	Workers *sync.WaitGroup
	DataDir string
	Workdir string
}
