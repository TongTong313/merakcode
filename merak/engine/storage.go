package engine

import (
	"context"
	"encoding/json"

	"github.com/TongTong313/merakcode/merak/engine/event"
	"github.com/TongTong313/merakcode/merak/engine/store"
)

const StorageChanged event.Type = "engine.storage"

func init() { event.Register[store.BufferState](StorageChanged) }

func (e *Engine) DisconnectedStorage() {
	if buffered, ok := e.store.(*store.Buffered); ok {
		buffered.Disconnect()
	}
}

func (e *Engine) watchStorage() {
	buffered, ok := e.store.(*store.Buffered)
	if !ok {
		return
	}
	stream := event.Stream("engine:" + e.newID())
	go func() {
		for {
			select {
			case <-e.ctx.Done():
				return
			case <-buffered.Changes():
				body, _ := json.Marshal(buffered.State())
				_, _ = e.Bus.Publish(e.ctx, event.Event{Stream: stream, Type: StorageChanged, Actor: event.Actor{Kind: event.ActorAgent}, Payload: body})
			}
		}
	}()
}

func (e *Engine) storageFull() bool {
	buffered, ok := e.store.(*store.Buffered)
	return ok && buffered.Full()
}

// ReconnectStorage waits for queued events to become durable before resuming requests.
func (e *Engine) ReconnectStorage(ctx context.Context, host store.Store) error {
	if buffered, ok := e.store.(*store.Buffered); ok {
		if err := buffered.Reconnect(ctx, host); err != nil {
			return err
		}
	}
	return e.Recover(ctx)
}
