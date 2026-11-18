package conversation

import (
	"context"
	"encoding/json"
	"strings"
	"time"

	"github.com/TongTong313/merakcode/merak/engine/agent/definition"
	"github.com/TongTong313/merakcode/merak/engine/agent/memory"
	"github.com/TongTong313/merakcode/merak/engine/agent/model"
	"github.com/TongTong313/merakcode/merak/engine/infra/event"
)

func (domain *Manager) extractMemory(c *Conversation) {
	state := c.State.Read()
	domain.mu.Lock()
	if len(c.queue) > 0 || domain.core.Ctx.Err() != nil || !domain.MemoryExtractOn() {
		domain.mu.Unlock()
		return
	}
	ctx, cancel := context.WithTimeout(domain.core.Ctx, 15*time.Second)
	c.memoryCancel = cancel
	domain.mu.Unlock()
	defer func() {
		cancel()
		domain.mu.Lock()
		c.memoryCancel = nil
		domain.mu.Unlock()
	}()
	var result memory.Extraction
	ref := domain.ExtractorModel(definition.ModelRef{Provider: state.Config.Provider, Model: state.Config.Model})
	provider := domain.registry.Provider(ref.Provider)
	if provider == nil {
		return
	}
	extractor := memory.ModelExtractor{Provider: provider, Model: ref.Model, OnUsage: func(usage model.Usage) { result.Usage = usage }}
	notes, err := extractor.Extract(ctx, state.Messages)
	result.Failed = err != nil
	if err == nil && ctx.Err() == nil {
		owner := memory.ProjectOwner(state.Config.Workdir)
		for _, note := range notes {
			note.Scope, note.Owner, note.Source = owner.Scope, owner.ID, state.ID
			note.ID, note.Created = domain.core.NewID(), domain.core.Now()
			if _, err := domain.notes.Remember(ctx, note); err == nil {
				result.Stored++
			}
		}
	}
	if domain.core.Ctx.Err() != nil {
		return
	}
	body, _ := json.Marshal(result)
	_, err = c.State.Publish(domain.core.Ctx, domain.core.Bus, event.Event{Stream: event.Stream("session:" + state.ID), Type: memory.Extracted, Scope: state.Scope, Actor: event.Actor{Kind: event.ActorAgent}, Payload: body})
	if err == nil {
		_ = domain.manager.Snapshot(domain.core.Ctx, c.State)
	}
}

// MemorySettings are the switches of the engine's memory. An engine that was not configured keeps both on; the
// server turns them to what the configuration says, which is off unless the user turned them on.
type MemorySettings struct {
	// AutoExtract saves notes from a conversation that has gone idle.
	AutoExtract bool
	// AutoRecall puts the notes that fit into the first turn of a conversation or a claim.
	AutoRecall bool
	// Model is "provider/model" of the model that writes notes (memory.model); empty means the model of the conversation.
	Model string
}

// ConfigureMemory applies MemorySettings; it takes effect on the next turn.
func (domain *Manager) ConfigureMemory(settings MemorySettings) {
	domain.memoryExtractOff.Store(!settings.AutoExtract)
	domain.memoryRecallOff.Store(!settings.AutoRecall)
	provider, name, found := strings.Cut(settings.Model, "/")
	if !found || provider == "" || name == "" {
		domain.memoryModel.Store(nil)
		return
	}
	domain.memoryModel.Store(&definition.ModelRef{Provider: provider, Model: name})
}

// ExtractorModel is the model that writes notes: the memory-extractor entry of the agent section, else memory.model,
// else own.
func (domain *Manager) ExtractorModel(own definition.ModelRef) definition.ModelRef {
	if ref, ok := domain.registry.ConfiguredJobModel("memory-extractor"); ok {
		return ref
	}
	if ref := domain.memoryModel.Load(); ref != nil {
		return *ref
	}
	return own
}

func (domain *Manager) MemoryExtractOn() bool { return !domain.memoryExtractOff.Load() }

func (domain *Manager) MemoryRecallOn() bool { return !domain.memoryRecallOff.Load() }

// BeginMemoryExtraction reserves a cause unless another extraction already holds it.
func (domain *Manager) BeginMemoryExtraction(cause event.ID) bool {
	_, running := domain.memoryExtractions.LoadOrStore(cause, true)
	return !running
}

// EndMemoryExtraction releases the cause when its extraction ends.
func (domain *Manager) EndMemoryExtraction(cause event.ID) {
	domain.memoryExtractions.Delete(cause)
}
