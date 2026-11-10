package server

import (
	"context"
	"errors"
	"sync"

	"github.com/TongTong313/merakcode/merak/engine"
	"github.com/TongTong313/merakcode/merak/engine/event"
	"github.com/TongTong313/merakcode/merak/protocol"
)

type remoteSession struct {
	mu     sync.Mutex
	ctx    context.Context
	cancel context.CancelFunc
	engine *engine.Engine
	host   event.ID
	peer   *engine.RemotePeer
}

func newRemoteSession(ctx context.Context, e *engine.Engine) *remoteSession {
	ctx, cancel := context.WithCancel(ctx)
	return &remoteSession{ctx: ctx, cancel: cancel, engine: e}
}

func (r *remoteSession) start(params protocol.RemoteStartParams) (protocol.RemoteStartResult, error) {
	peer, err := r.attach(params.Host)
	if err != nil {
		return protocol.RemoteStartResult{}, err
	}
	return peer.Start(r.ctx, params)
}

func (r *remoteSession) sync(params protocol.RemoteSyncParams) error {
	peer, err := r.attach(params.Host)
	if err != nil {
		return err
	}
	return peer.Sync(r.ctx, params)
}

func (r *remoteSession) deliver(params protocol.RemoteDeliveryParams) (protocol.RemoteDelivery, error) {
	peer, err := r.attach(params.Host)
	if err != nil {
		return protocol.RemoteDelivery{}, err
	}
	return peer.Deliver(r.ctx, params)
}

func (r *remoteSession) attach(id event.ID) (*engine.RemotePeer, error) {
	r.mu.Lock()
	if r.ctx.Err() != nil {
		r.mu.Unlock()
		return nil, r.ctx.Err()
	}
	if r.peer == nil {
		peer, err := r.engine.AttachRemotePeer(r.ctx, id)
		if err != nil {
			r.mu.Unlock()
			return nil, err
		}
		r.peer, r.host = peer, id
	}
	peer, host := r.peer, r.host
	r.mu.Unlock()
	if host != id {
		return nil, errors.New("remote connection cannot change its host")
	}
	return peer, nil
}

func (r *remoteSession) close() {
	r.mu.Lock()
	r.cancel()
	peer := r.peer
	r.mu.Unlock()
	if peer != nil {
		peer.Close()
	}
}

func (r *remoteSession) control(params protocol.RemoteControlParams) error {
	r.mu.Lock()
	peer := r.peer
	r.mu.Unlock()
	if peer == nil {
		return errors.New("remote host is not attached")
	}
	return peer.Control(r.ctx, params)
}
