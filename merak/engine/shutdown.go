package engine

import (
	"context"
	"encoding/json"
	"os"

	"github.com/TongTong313/merakcode/merak/engine/event"
)

const Shutdown event.Type = "engine.shutdown"

func init() { event.Register[struct{}](Shutdown) }

func (e *Engine) Shutdown(ctx context.Context) error {
	e.shutdownOnce.Do(func() {
		e.cancel()
		go func() {
			defer close(e.shutdownDone)
			result := make(chan error, 1)
			go func() { result <- e.shutdown(ctx) }()
			select {
			case e.shutdownErr = <-result:
			case <-ctx.Done():
				e.shutdownErr = ctx.Err()
			}
		}()
	})
	select {
	case <-e.shutdownDone:
		return e.shutdownErr
	case <-ctx.Done():
		return ctx.Err()
	}
}

func (e *Engine) shutdown(ctx context.Context) error {
	defer e.disconnectCloud()
	defer func() {
		e.snapshotMu.Lock()
		defer e.snapshotMu.Unlock()
		if e.snapshotTemp {
			_ = os.RemoveAll(e.snapshotDir)
		}
	}()
	e.Terminals.Close()
	e.Workspaces.Close()
	e.mu.Lock()
	e.mu.Unlock()
	e.workers.Wait()
	e.cloudMu.Lock()
	connected, link := e.cloudCancel != nil, e.cloud
	e.cloudMu.Unlock()
	if connected {
		if err := e.flushCloud(ctx, link); err != nil {
			return err
		}
	}
	e.releaseSandbox("")
	if e.sandboxErr != nil {
		return e.sandboxErr
	}
	e.mu.Lock()
	defer e.mu.Unlock()
	for _, c := range e.sessions {
		if err := e.manager.Reconcile(ctx, c.state); err != nil {
			return err
		}
		if err := e.manager.Snapshot(ctx, c.state); err != nil {
			return err
		}
	}
	_, err := e.Bus.Publish(ctx, event.Event{Stream: event.Stream("engine:" + e.newID()), Type: Shutdown, Actor: event.Actor{Kind: event.ActorAgent}, Payload: json.RawMessage(`{}`)})
	return err
}
