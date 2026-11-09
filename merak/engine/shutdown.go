package engine

import (
	"context"
	"encoding/json"

	"github.com/TongTong313/merakcode/merak/engine/event"
	"github.com/TongTong313/merakcode/merak/engine/store"
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
	e.Terminals.Close()
	e.Workspaces.Close()
	e.mu.Lock()
	e.mu.Unlock()
	e.workers.Wait()
	e.releaseSandbox("")
	if e.sandboxErr != nil {
		return e.sandboxErr
	}
	if buffered, ok := e.store.(*store.Buffered); ok {
		if err := buffered.Wait(ctx); err != nil {
			return err
		}
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
	if err != nil {
		return err
	}
	if buffered, ok := e.store.(*store.Buffered); ok {
		return buffered.Wait(ctx)
	}
	return nil
}
