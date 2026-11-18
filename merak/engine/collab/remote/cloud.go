package remote

import (
	"context"
	"encoding/json"
	"errors"
	"sync"
	"time"

	"github.com/TongTong313/merakcode/merak/engine/agent/definition"
	"github.com/TongTong313/merakcode/merak/engine/collab/group"
	"github.com/TongTong313/merakcode/merak/engine/collab/wire"
	"github.com/TongTong313/merakcode/merak/engine/infra/event"
	"github.com/TongTong313/merakcode/merak/engine/infra/store"
)

func (r *Remote) Barrier() {
	r.mu.Lock()
	r.mu.Unlock()
}

func (domain *Remote) FlushConnectedCloud(ctx context.Context) error {
	domain.cloudMu.Lock()
	connected, link := domain.cloudCancel != nil, domain.cloud
	domain.cloudMu.Unlock()
	if connected {
		return domain.flushCloud(ctx, link)
	}
	return nil
}

func (domain *Remote) DiscoverGroups(ctx context.Context) error {
	domain.cloudMu.Lock()
	host := domain.cloudHost
	domain.cloudMu.Unlock()
	request, cancel := context.WithTimeout(ctx, 2*time.Second)
	body, _ := json.Marshal(store.Query{Types: []event.Type{group.Created}})
	result, err := domain.forwardFromHost(request, host, "events.find", body)
	if err == nil {
		var facts []event.Event
		if err = json.Unmarshal(result, &facts); err == nil {
			for _, fact := range facts {
				if fact.Type != group.Created {
					cancel()
					return errors.New("MRK-1007")
				}
			}
			err = domain.importCloudFrom(request, host, facts)
		}
	}
	cancel()
	if err != nil && ctx.Err() != nil {
		return ctx.Err()
	}
	return nil
}

type PendingWorkerQuestion struct {
	group, Task, member event.ID
	Reply               chan string
	answered            bool
}

// ConnectCloud owns the link until logout or the final shutdown upload finishes.
func (domain *Remote) ConnectCloud(ctx context.Context, creds wire.Credentials) error {
	domain.cloudLifecycle.Lock()
	defer domain.cloudLifecycle.Unlock()
	if err := domain.core.Ctx.Err(); err != nil {
		return err
	}
	if !wire.ValidEndpoint(creds.Endpoint) || creds.Token == "" || creds.Account == "" || creds.Device == "" {
		return errors.New("MRK-3001")
	}
	domain.cloudMu.Lock()
	if domain.cloudCancel != nil {
		domain.cloudMu.Unlock()
		return errors.New("MRK-1007")
	}
	if domain.newLink == nil {
		domain.cloudMu.Unlock()
		return wire.ErrNoCloud
	}
	domain.cloud = domain.newLink()
	lifetime, cancel := context.WithCancel(context.Background())
	domain.cloudCancel, domain.cloudDone, domain.cloudCredentials = cancel, make(chan struct{}), creds
	domain.cloudWorkCtx, domain.cloudWorkCancel = context.WithCancel(domain.core.Ctx)
	domain.cloudJobs = new(sync.WaitGroup)
	domain.cloudHost = &deviceHost{id: wire.Identity(creds), device: creds.Device, context: domain.cloudWorkCtx, jobs: domain.cloudJobs}
	link, done := domain.cloud, domain.cloudDone
	domain.cloudMu.Unlock()
	go func() { defer close(done); _ = link.Connect(lifetime, creds) }()
	if err := domain.recoverDeviceRuns(ctx, wire.Identity(creds)); err != nil {
		domain.disconnectCloudLocked()
		return err
	}
	members, err := domain.DeviceMembers(ctx)
	if err != nil {
		domain.disconnectCloudLocked()
		return err
	}
	announcement, stopAnnouncement := context.WithTimeout(ctx, time.Second)
	_ = link.Announce(announcement, members)
	stopAnnouncement()
	var workers sync.WaitGroup
	domain.cloudMu.Lock()
	loops := make(chan struct{})
	domain.cloudLoops = loops
	domain.cloudMu.Unlock()
	live, stopLive := domain.core.Bus.Subscribe(event.Filter{Types: []event.Type{"message.delta"}})
	workers.Go(func() { domain.publishCloudLive(lifetime, link, live, stopLive) })
	workers.Go(func() { domain.publishCloud(lifetime, link) })
	workers.Go(func() { domain.receiveCloud(lifetime, link) })
	changes, stop := domain.core.Bus.Subscribe(event.Filter{Types: []event.Type{group.Created, group.MemberAdded, group.MemberUpdated, group.MemberRemoved}})
	workers.Go(func() {
		defer func() { stop() }()
		for {
			select {
			case <-lifetime.Done():
				return
			case <-domain.execution.MemberUpdates():
			case fact, ok := <-changes:
				if !ok || fact.Type == event.Lagged {
					stop()
					changes, stop = domain.core.Bus.Subscribe(event.Filter{Types: []event.Type{group.Created, group.MemberAdded, group.MemberUpdated, group.MemberRemoved}})
				}
			}
			request, stopRequest := context.WithTimeout(lifetime, 10*time.Second)
			members, err := domain.DeviceMembers(request)
			if err == nil {
				_ = link.Announce(request, members)
			}
			stopRequest()
		}
	})
	go func() { workers.Wait(); close(loops) }()
	return nil
}

func (domain *Remote) CloudStatus() wire.CloudStatus {
	domain.cloudMu.Lock()
	defer domain.cloudMu.Unlock()
	status := wire.CloudStatus{Account: domain.cloudCredentials.Account, Device: domain.cloudCredentials.Device, Endpoint: domain.cloudCredentials.Endpoint}
	if link, ok := domain.cloud.(interface{ Online() bool }); ok {
		status.Online = link.Online()
	}
	return status
}

// CloudMembers reads the account directory from the current cloud host.
func (domain *Remote) CloudMembers(ctx context.Context) ([]group.Member, error) {
	domain.cloudMu.Lock()
	host := domain.cloudHost
	domain.cloudMu.Unlock()
	body, err := domain.forwardFromHost(ctx, host, "cloud.members", json.RawMessage(`{}`))
	if err != nil {
		return nil, err
	}
	domain.cloudMu.Lock()
	current := host != nil && domain.cloudHost == host
	domain.cloudMu.Unlock()
	if !current {
		return nil, wire.ErrNoCloud
	}
	members := []group.Member{}
	if err := json.Unmarshal(body, &members); err != nil {
		return nil, wire.ErrUnavailable
	}
	return members, nil
}

func (domain *Remote) DisconnectCloud(ctx context.Context) error {
	domain.cloudLifecycle.Lock()
	defer domain.cloudLifecycle.Unlock()
	domain.cloudMu.Lock()
	if domain.cloudWorkCancel != nil {
		domain.cloudWorkCancel()
	}
	jobs := domain.cloudJobs
	link := domain.cloud
	domain.cloudMu.Unlock()
	if jobs != nil {
		done := make(chan struct{})
		go func() { jobs.Wait(); close(done) }()
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-done:
		}
	}
	ending, stop := context.WithTimeout(ctx, 2*time.Second)
	_ = domain.flushCloud(ending, link)
	stop()
	domain.disconnectCloudLocked()
	return nil
}

func (domain *Remote) DeviceMembers(ctx context.Context) ([]group.Member, error) {
	facts, err := domain.core.Store.Find(ctx, store.Query{Types: []event.Type{group.Created}})
	if err != nil {
		return nil, err
	}
	domain.cloudMu.Lock()
	creds := domain.cloudCredentials
	domain.cloudMu.Unlock()
	members := []group.Member{}
	for _, fact := range facts {
		state, err := domain.groups.Get(ctx, fact.Scope.Group)
		if err != nil {
			return nil, err
		}
		if state.Group.Kind == group.KindCloud {
			continue
		}
		if _, hosted := domain.roster.HostedGroup(state.Group.ID); hosted {
			continue
		}
		for _, member := range state.Members {
			if member.Kind != group.MemberAgent {
				continue
			}
			p, err := domain.roster.MemberAgent(ctx, member)
			if err != nil {
				return nil, err
			}
			if p.Product != nil && p.Product.Kind == definition.KindRemote {
				continue
			}
			member.Device, member.Account, member.Summary = creds.Device, creds.Account, p.Summary
			if domain.execution.MemberBusy(state.Group.ID, member.ID) {
				member.Status = group.Busy
			}
			members = append(members, member)
		}
	}
	return members, nil
}

func (domain *Remote) CloseCloud() {
	domain.cloudLifecycle.Lock()
	defer domain.cloudLifecycle.Unlock()
	domain.disconnectCloudLocked()
}

func (domain *Remote) disconnectCloudLocked() {
	domain.cloudMu.Lock()
	cancel, done, loops := domain.cloudCancel, domain.cloudDone, domain.cloudLoops
	if domain.cloudWorkCancel != nil {
		domain.cloudWorkCancel()
	}
	domain.cloudMu.Unlock()
	if cancel == nil {
		return
	}
	cancel()
	<-done
	if loops != nil {
		<-loops
	}
	domain.cloudMu.Lock()
	domain.cloudCancel = nil
	domain.cloudLoops = nil
	domain.cloudCredentials = wire.Credentials{}
	domain.cloudHost = nil
	domain.cloudMu.Unlock()
}
