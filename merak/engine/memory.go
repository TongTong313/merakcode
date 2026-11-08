package engine

import (
	"context"
	"encoding/json"
	"time"

	"github.com/TongTong313/merakcode/merak/engine/event"
	"github.com/TongTong313/merakcode/merak/engine/memory"
	"github.com/TongTong313/merakcode/merak/engine/model"
	"github.com/TongTong313/merakcode/merak/engine/session"
)

func (e *Engine) extractMemory(c *conversation) {
	e.mu.Lock()
	if len(c.queue) > 0 || e.ctx.Err() != nil {
		e.mu.Unlock()
		return
	}
	ctx, cancel := context.WithTimeout(e.ctx, 15*time.Second)
	c.memoryCancel = cancel
	e.mu.Unlock()
	defer func() {
		cancel()
		e.mu.Lock()
		c.memoryCancel = nil
		e.mu.Unlock()
	}()
	var result memory.Extraction
	extractor := memory.ModelExtractor{Provider: e.providers[c.state.Config.Provider], Model: c.state.Config.Model, OnUsage: func(usage model.Usage) { result.Usage = usage }}
	notes, err := extractor.Extract(ctx, c.state.Messages)
	result.Failed = err != nil
	if err == nil && ctx.Err() == nil {
		owner := memory.ProjectOwner(c.state.Config.Workdir)
		for _, note := range notes {
			note.Scope, note.Owner, note.Source = owner.Scope, owner.ID, c.state.ID
			note.ID, note.Created = e.newID(), e.now()
			if _, err := e.notes.Remember(ctx, note); err == nil {
				result.Stored++
			}
		}
	}
	if e.ctx.Err() != nil {
		return
	}
	body, _ := json.Marshal(result)
	fact, err := e.Bus.Publish(e.ctx, event.Event{Stream: event.Stream("session:" + c.state.ID), Type: memory.Extracted, Scope: c.state.Scope, Actor: event.Actor{Kind: event.ActorAgent}, Payload: body})
	if err == nil {
		_ = session.Fold(c.state, fact)
		_ = e.manager.Snapshot(e.ctx, c.state)
	}
}
