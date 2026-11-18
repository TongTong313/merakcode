package remote

import (
	"context"
	"sync"

	"github.com/TongTong313/merakcode/merak/engine/infra/event"
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

func (domain *Remote) deviceHostForGroup(id event.ID) *deviceHost {
	owner, ok := domain.roster.HostedGroup(id)
	if !ok {
		return nil
	}
	domain.cloudMu.Lock()
	defer domain.cloudMu.Unlock()
	if domain.cloudHost != nil && domain.cloudHost.id == owner {
		return domain.cloudHost
	}
	return domain.remoteHosts[owner.(string)]
}

func (domain *Remote) ActiveDeviceGroup(id event.ID) bool {
	host := domain.deviceHostForGroup(id)
	return host != nil && host.context.Err() == nil
}
