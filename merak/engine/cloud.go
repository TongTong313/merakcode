package engine

import (
	"context"
	"encoding/json"
	"errors"
	"sync"
	"time"

	"github.com/TongTong313/merakcode/merak/engine/event"
	"github.com/TongTong313/merakcode/merak/engine/group"
	"github.com/TongTong313/merakcode/merak/engine/store"
	"github.com/TongTong313/merakcode/merak/engine/worker"
	"github.com/TongTong313/merakcode/merak/internal/cloud"
	"github.com/TongTong313/merakcode/merak/protocol"
)

// ConnectCloud owns the link until logout or the final shutdown upload finishes.
func (e *Engine) ConnectCloud(ctx context.Context, creds cloud.Credentials) error {
	e.cloudLifecycle.Lock()
	defer e.cloudLifecycle.Unlock()
	if err := e.ctx.Err(); err != nil {
		return err
	}
	if !cloud.ValidEndpoint(creds.Endpoint) || creds.Token == "" || creds.Account == "" || creds.Device == "" {
		return errors.New("MRK-3001")
	}
	e.cloudMu.Lock()
	if e.cloudCancel != nil {
		e.cloudMu.Unlock()
		return errors.New("MRK-1007")
	}
	switch e.cloud.(type) {
	case cloud.Null, *cloud.WebSocket:
		e.cloud = cloud.NewWebSocket()
	}
	lifetime, cancel := context.WithCancel(context.Background())
	e.cloudCancel, e.cloudDone, e.cloudCredentials = cancel, make(chan struct{}), creds
	e.cloudWorkCtx, e.cloudWorkCancel = context.WithCancel(e.ctx)
	e.cloudJobs = new(sync.WaitGroup)
	e.cloudHost = &deviceHost{id: cloud.Identity(creds), device: creds.Device, context: e.cloudWorkCtx, jobs: e.cloudJobs}
	link, done := e.cloud, e.cloudDone
	e.cloudMu.Unlock()
	go func() { defer close(done); _ = link.Connect(lifetime, creds) }()
	if err := e.recoverDeviceRuns(ctx, cloud.Identity(creds)); err != nil {
		e.disconnectCloudLocked()
		return err
	}
	members, err := e.DeviceMembers(ctx)
	if err != nil {
		e.disconnectCloudLocked()
		return err
	}
	announcement, stopAnnouncement := context.WithTimeout(ctx, time.Second)
	_ = link.Announce(announcement, members)
	stopAnnouncement()
	var workers sync.WaitGroup
	e.cloudMu.Lock()
	loops := make(chan struct{})
	e.cloudLoops = loops
	e.cloudMu.Unlock()
	live, stopLive := e.Bus.Subscribe(event.Filter{Types: []event.Type{"message.delta"}})
	workers.Go(func() { e.publishCloudLive(lifetime, link, live, stopLive) })
	workers.Go(func() { e.publishCloud(lifetime, link) })
	workers.Go(func() { e.receiveCloud(lifetime, link) })
	changes, stop := e.Bus.Subscribe(event.Filter{Types: []event.Type{group.Created, group.MemberAdded, group.MemberUpdated, group.MemberRemoved}})
	workers.Go(func() {
		defer func() { stop() }()
		for {
			select {
			case <-lifetime.Done():
				return
			case <-e.memberChanges:
			case fact, ok := <-changes:
				if !ok || fact.Type == event.Lagged {
					stop()
					changes, stop = e.Bus.Subscribe(event.Filter{Types: []event.Type{group.Created, group.MemberAdded, group.MemberUpdated, group.MemberRemoved}})
				}
			}
			request, stopRequest := context.WithTimeout(lifetime, 10*time.Second)
			members, err := e.DeviceMembers(request)
			if err == nil {
				_ = link.Announce(request, members)
			}
			stopRequest()
		}
	})
	go func() { workers.Wait(); close(loops) }()
	return nil
}

func (e *Engine) CloudStatus() protocol.CloudStatus {
	e.cloudMu.Lock()
	defer e.cloudMu.Unlock()
	status := protocol.CloudStatus{Account: e.cloudCredentials.Account, Device: e.cloudCredentials.Device, Endpoint: e.cloudCredentials.Endpoint}
	if link, ok := e.cloud.(interface{ Online() bool }); ok {
		status.Online = link.Online()
	}
	return status
}

// CloudMembers reads the account directory from the current cloud host.
func (e *Engine) CloudMembers(ctx context.Context) ([]group.Member, error) {
	e.cloudMu.Lock()
	host := e.cloudHost
	e.cloudMu.Unlock()
	body, err := e.forwardFromHost(ctx, host, "cloud.members", json.RawMessage(`{}`))
	if err != nil {
		return nil, err
	}
	e.cloudMu.Lock()
	current := host != nil && e.cloudHost == host
	e.cloudMu.Unlock()
	if !current {
		return nil, cloud.ErrNoCloud
	}
	members := []group.Member{}
	if err := json.Unmarshal(body, &members); err != nil {
		return nil, cloud.ErrUnavailable
	}
	return members, nil
}

func (e *Engine) DisconnectCloud(ctx context.Context) error {
	e.cloudLifecycle.Lock()
	defer e.cloudLifecycle.Unlock()
	e.cloudMu.Lock()
	if e.cloudWorkCancel != nil {
		e.cloudWorkCancel()
	}
	jobs := e.cloudJobs
	link := e.cloud
	e.cloudMu.Unlock()
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
	_ = e.flushCloud(ending, link)
	stop()
	e.disconnectCloudLocked()
	return nil
}

func (e *Engine) DeviceMembers(ctx context.Context) ([]group.Member, error) {
	facts, err := e.store.Find(ctx, store.Query{Types: []event.Type{group.Created}})
	if err != nil {
		return nil, err
	}
	e.cloudMu.Lock()
	creds := e.cloudCredentials
	e.cloudMu.Unlock()
	members := []group.Member{}
	for _, fact := range facts {
		state, err := e.Groups.Get(ctx, fact.Scope.Group)
		if err != nil {
			return nil, err
		}
		if state.Group.Kind == group.KindCloud {
			continue
		}
		if _, hosted := e.hostedGroups.Load(state.Group.ID); hosted {
			continue
		}
		for _, member := range state.Members {
			if member.Kind != group.MemberAgent {
				continue
			}
			p, err := e.memberAgent(ctx, member)
			if err != nil {
				return nil, err
			}
			if p.Product != nil && p.Product.Kind == worker.KindRemote {
				continue
			}
			member.Device, member.Account, member.Summary = creds.Device, creds.Account, p.Summary
			e.memberMu.Lock()
			if e.memberExecutions[memberExecution{state.Group.ID, member.ID}] != nil {
				member.Status = group.Busy
			}
			e.memberMu.Unlock()
			members = append(members, member)
		}
	}
	return members, nil
}

func (e *Engine) disconnectCloud() {
	e.cloudLifecycle.Lock()
	defer e.cloudLifecycle.Unlock()
	e.disconnectCloudLocked()
}

func (e *Engine) disconnectCloudLocked() {
	e.cloudMu.Lock()
	cancel, done, loops := e.cloudCancel, e.cloudDone, e.cloudLoops
	if e.cloudWorkCancel != nil {
		e.cloudWorkCancel()
	}
	e.cloudMu.Unlock()
	if cancel == nil {
		return
	}
	cancel()
	<-done
	if loops != nil {
		<-loops
	}
	e.cloudMu.Lock()
	e.cloudCancel = nil
	e.cloudLoops = nil
	e.cloudCredentials = cloud.Credentials{}
	e.cloudHost = nil
	e.cloudMu.Unlock()
}
