package engine

import (
	"context"
	"sync"

	"github.com/TongTong313/merakcode/merak/engine/event"
)

// deviceHost owns task state while this engine owns its member executions.
type deviceHost struct {
	imports sync.Mutex
	starts  sync.Mutex
	id      string
	device  string
	context context.Context
	jobs    *sync.WaitGroup
	cancel  context.CancelFunc
	peers   int
	ready   chan struct{}
	err     error
}

func (e *Engine) deviceHostForGroup(id event.ID) *deviceHost {
	owner, ok := e.hostedGroups.Load(id)
	if !ok {
		return nil
	}
	e.cloudMu.Lock()
	defer e.cloudMu.Unlock()
	if e.cloudHost != nil && e.cloudHost.id == owner {
		return e.cloudHost
	}
	return e.remoteHosts[owner.(string)]
}

func (e *Engine) activeDeviceGroup(id event.ID) bool {
	host := e.deviceHostForGroup(id)
	return host != nil && host.context.Err() == nil
}
