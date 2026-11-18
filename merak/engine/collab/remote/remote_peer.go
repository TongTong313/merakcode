package remote

import (
	"context"
	"encoding/json"
	"errors"
	"sync"

	"github.com/TongTong313/merakcode/merak/engine/agent/permission"
	"github.com/TongTong313/merakcode/merak/engine/agent/question"
	"github.com/TongTong313/merakcode/merak/engine/collab/group"
	"github.com/TongTong313/merakcode/merak/engine/collab/wire"
	"github.com/TongTong313/merakcode/merak/engine/infra/event"
	"github.com/TongTong313/merakcode/merak/engine/infra/store"
)

// RemotePeer binds foreign assignments to one authenticated connection lifetime.
type RemotePeer struct {
	owner  *Remote
	host   *deviceHost
	ctx    context.Context
	jobs   sync.WaitGroup
	cancel context.CancelFunc
	stop   func() bool
	once   sync.Once
}

func (domain *Remote) AttachRemotePeer(ctx context.Context, id event.ID) (*RemotePeer, error) {
	if id == "" || len(id) > 128 {
		return nil, errors.New("remote host identity is required")
	}
	domain.cloudMu.Lock()
	if domain.core.Ctx.Err() != nil || ctx.Err() != nil {
		domain.cloudMu.Unlock()
		return nil, context.Canceled
	}
	key := "remote:" + string(id)
	host := domain.remoteHosts[key]
	created := host == nil
	if created {
		work, cancel := context.WithCancel(domain.core.Ctx)
		host = &deviceHost{id: key, device: key, context: work, cancel: cancel, ready: make(chan struct{})}
	}
	host.peers++
	work, cancel := context.WithCancel(host.context)
	peer := &RemotePeer{owner: domain, host: host, ctx: work, cancel: cancel, stop: context.AfterFunc(ctx, cancel)}
	if domain.remoteHosts == nil {
		domain.remoteHosts = make(map[string]*deviceHost)
	}
	domain.remoteHosts[key] = host
	domain.cloudMu.Unlock()
	if created {
		host.err = domain.recoverDeviceRuns(ctx, key)
		close(host.ready)
	}
	select {
	case <-host.ready:
		if host.err != nil {
			peer.Close()
			return nil, host.err
		}
	case <-ctx.Done():
		peer.Close()
		return nil, ctx.Err()
	}
	return peer, nil
}

func (p *RemotePeer) Close() {
	p.once.Do(func() {
		p.owner.cloudMu.Lock()
		p.cancel()
		p.owner.cloudMu.Unlock()
		p.jobs.Wait()
		p.stop()
		p.owner.cloudMu.Lock()
		p.host.peers--
		if p.host.peers == 0 {
			p.host.cancel()
			delete(p.owner.remoteHosts, p.host.id)
		}
		p.owner.cloudMu.Unlock()
	})
}

func (p *RemotePeer) Start(ctx context.Context, params wire.RemoteStartParams) (wire.RemoteStartResult, error) {
	p.host.starts.Lock()
	defer p.host.starts.Unlock()
	var result wire.RemoteStartResult
	if p.ctx.Err() != nil {
		return result, p.ctx.Err()
	}
	domain, a := p.owner, params.Assignment
	if p.host.id != "remote:"+string(params.Host) || a.Scope.Group == "" || a.Cause == "" {
		return result, errors.New("assignment host and cause are required")
	}
	source, err := domain.groups.Get(ctx, a.SourceGroup)
	if _, hosted := domain.roster.HostedGroup(a.SourceGroup); err != nil || hosted || source.Group.Kind != group.KindLocal {
		return result, errors.New("remote assignments require a local source group")
	}
	member, err := domain.roster.GroupMember(ctx, a.SourceGroup, a.Member)
	if err != nil || member.Kind != group.MemberAgent || member.Remote {
		return result, errors.New("remote assignments require a registered local agent")
	}
	if err := p.importGroup(ctx, a.Scope.Group, params.Events); err != nil {
		return result, err
	}
	key := p.host.id + "/" + string(a.Claim.ID) + "/" + string(a.Cause)
	doc, err := domain.core.Store.Fetch(ctx, "remote-start", key)
	if err == nil {
		if err := json.Unmarshal(doc.Body, &result); err != nil {
			return result, err
		}
	} else if !errors.Is(err, store.ErrNotFound) {
		return result, err
	}
	facts, err := domain.core.Store.Find(ctx, store.Query{Scope: event.Scope{Group: a.Scope.Group, Session: a.Session}, Types: []event.Type{DeviceReported, DeviceInterrupted, permission.Replied, question.Answered, group.MemberAnswered, wire.RemoteLookupRequested}})
	if err != nil {
		return result, err
	}
	for _, fact := range facts {
		if fact.Type == wire.RemoteLookupRequested {
			domain.cloudReplyMu.Lock()
			pending := domain.remoteLookups[fact.ID]
			answered := pending == nil || len(pending) > 0
			domain.cloudReplyMu.Unlock()
			if answered {
				result.Answered = append(result.Answered, fact.ID)
			}
			continue
		}
		if fact.Type == DeviceReported || fact.Type == DeviceInterrupted {
			if fact.Cause == a.Cause {
				result.Completed = true
			}
		} else if fact.Cause != "" {
			result.Answered = append(result.Answered, fact.Cause)
		}
	}
	if result.Completed {
		return result, nil
	}
	domain.cloudMu.Lock()
	prior := domain.deviceRuns[a.Claim.ID]
	domain.cloudMu.Unlock()
	if prior != nil {
		if prior.host != p.host {
			return result, store.ErrConflict
		}
		if prior.assignment.Cause != a.Cause {
			select {
			case <-prior.done:
			case <-ctx.Done():
				return result, ctx.Err()
			}
		}
	}
	if result.Cursors == nil {
		result.Cursors = map[event.Stream]uint64{}
		for _, stream := range []event.Stream{event.Stream("session:" + a.Session), event.Stream("device:" + p.host.device + ":group:" + string(a.Scope.Group))} {
			if err := domain.ownDeviceStream(ctx, stream, p.host.id); err != nil {
				return result, err
			}
			result.Cursors[stream] = domain.core.Bus.Position(stream)
		}
		body, _ := json.Marshal(wire.RemoteStartResult{Cursors: result.Cursors})
		if err := domain.core.Store.Put(ctx, store.Doc{Kind: "remote-start", Key: key, Body: body}); err != nil {
			return result, err
		}
	}
	domain.startDeviceExecution(p.host, a, p.ctx, &p.jobs)
	return result, nil
}

func (p *RemotePeer) Sync(ctx context.Context, params wire.RemoteSyncParams) error {
	if params.Group == "" || p.host.id != "remote:"+string(params.Host) {
		return errors.New("remote synchronization requires its host and group")
	}
	return p.importGroup(ctx, params.Group, params.Events)
}

func (p *RemotePeer) Control(ctx context.Context, params wire.RemoteControlParams) error {
	domain := p.owner
	operations := 0
	for _, present := range []bool{params.Lookup != nil, params.Message != nil, params.Cancel != nil, params.Reply != nil, params.QuestionReply != nil} {
		if present {
			operations++
		}
	}
	if operations != 1 {
		return errors.New("remote control requires exactly one operation")
	}
	var claim event.ID
	if params.Message != nil {
		claim = params.Message.Claim
	}
	if params.Cancel != nil {
		claim = *params.Cancel
	}
	if claim != "" {
		domain.cloudMu.Lock()
		run := domain.deviceRuns[claim]
		domain.cloudMu.Unlock()
		if run == nil || run.host != p.host {
			return store.ErrNotFound
		}
	}
	var lookup event.ID
	if params.Lookup != nil {
		lookup = params.Lookup.Request
	}
	for _, request := range []event.ID{permissionRequest(params), questionRequest(params), lookup} {
		if request == "" {
			continue
		}
		fact, err := domain.core.Store.Get(ctx, request)
		if err != nil || domain.deviceHostForGroup(fact.Scope.Group) != p.host {
			return store.ErrNotFound
		}
	}
	if params.Message != nil {
		domain.sendDeviceMessage(ctx, *params.Message)
	}
	if params.Cancel != nil {
		domain.cancelDeviceClaim(ctx, *params.Cancel)
	}
	if params.Reply != nil {
		domain.answerDevicePermission(*params.Reply)
	}
	if params.QuestionReply != nil {
		domain.answerDeviceQuestion(ctx, *params.QuestionReply)
	}
	if params.Lookup != nil {
		return domain.answerRemoteLookup(ctx, *params.Lookup)
	}
	return nil
}

func permissionRequest(params wire.RemoteControlParams) event.ID {
	if params.Reply != nil {
		return params.Reply.Request
	}
	return ""
}

func questionRequest(params wire.RemoteControlParams) event.ID {
	if params.QuestionReply != nil {
		return params.QuestionReply.Request
	}
	return ""
}

func (p *RemotePeer) importGroup(ctx context.Context, id event.ID, facts []event.Event) error {
	p.host.imports.Lock()
	defer p.host.imports.Unlock()
	domain := p.owner
	doc, err := domain.core.Store.Fetch(ctx, "remote-group", string(id))
	if err != nil && !errors.Is(err, store.ErrNotFound) {
		return err
	}
	if err == nil && doc.Meta["host"] != p.host.id {
		return store.ErrConflict
	}
	if errors.Is(err, store.ErrNotFound) {
		if _, err := domain.groups.Get(ctx, id); !errors.Is(err, store.ErrNotFound) {
			return store.ErrConflict
		}
		if len(facts) == 0 || facts[0].Type != group.Created {
			return errors.New("remote group history must start with its creation")
		}
		state, err := event.Decode[group.State](facts[0])
		if err != nil || state.Group.Kind != group.KindLocal || state.Group.ID != id {
			return errors.New("invalid remote group")
		}
		body, _ := json.Marshal(state.Group)
		if err := domain.core.Store.Put(ctx, store.Doc{Kind: "remote-group", Key: string(id), Body: body, Meta: map[string]string{"host": p.host.id}}); err != nil {
			return err
		}
	}
	domain.roster.HostGroup(id, p.host.id)
	stream := event.Stream("group:" + id)
	if err := store.ResumeStream(ctx, domain.core.Bus, domain.core.Store, stream); err != nil {
		return err
	}
	for _, fact := range facts {
		if fact.Scope.Group != id || fact.Stream != stream || event.Transient(fact.Type) {
			return errors.New("remote task history is outside its group")
		}
		if stored, err := domain.core.Store.Get(ctx, fact.ID); err == nil {
			if stored.Stream != stream || stored.Seq != fact.Seq {
				return store.ErrConflict
			}
			continue
		} else if !errors.Is(err, store.ErrNotFound) {
			return err
		}
		if err := domain.core.Bus.Import(ctx, fact); err != nil {
			return err
		}
		if err := domain.tasks.Observe(ctx, fact); err != nil {
			return err
		}
	}
	return nil
}
