package engine

import (
	"context"
	"encoding/json"
	"time"

	"github.com/TongTong313/merakcode/merak/engine/infra/event"
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
	defer e.remote.CloseCloud()
	e.terminals.Close()
	e.workspaces.Close()
	e.conversation.Barrier()
	e.execution.Barrier()
	e.remote.Barrier()
	e.coordinator.Barrier()
	e.core.Workers.Wait()
	if err := e.remote.FlushConnectedCloud(ctx); err != nil {
		return err
	}
	e.execution.ReleaseSandbox("")
	if err := e.execution.SandboxFailure(); err != nil {
		return err
	}
	if err := e.conversation.Checkpoint(ctx); err != nil {
		return err
	}
	_, err := e.core.Bus.Publish(ctx, event.Event{Stream: event.Stream("engine:" + e.core.NewID()), Type: Shutdown, Actor: event.Actor{Kind: event.ActorAgent}, Payload: json.RawMessage(`{}`)})
	return err
}

func (e *Engine) Close() error {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	return e.Shutdown(ctx)
}
