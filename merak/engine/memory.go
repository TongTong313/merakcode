package engine

import (
	"context"
	"encoding/json"
	"errors"
	"strconv"
	"strings"
	"time"

	"github.com/TongTong313/merakcode/merak/engine/agent"
	"github.com/TongTong313/merakcode/merak/engine/event"
	"github.com/TongTong313/merakcode/merak/engine/group"
	"github.com/TongTong313/merakcode/merak/engine/memory"
	"github.com/TongTong313/merakcode/merak/engine/model"
	"github.com/TongTong313/merakcode/merak/engine/session"
	"github.com/TongTong313/merakcode/merak/engine/store"
	"github.com/TongTong313/merakcode/merak/engine/task"
	"github.com/TongTong313/merakcode/merak/engine/window"
)

func (e *Engine) extractMemory(c *conversation) {
	e.mu.Lock()
	if len(c.queue) > 0 || e.ctx.Err() != nil || !e.memoryExtractOn() {
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
	ref := e.extractorModel(agent.ModelRef{Provider: c.state.Config.Provider, Model: c.state.Config.Model})
	provider := e.provider(ref.Provider)
	if provider == nil {
		return
	}
	extractor := memory.ModelExtractor{Provider: provider, Model: ref.Model, OnUsage: func(usage model.Usage) { result.Usage = usage }}
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

func (e *Engine) extractTaskMemory(card task.Card, cause event.ID) {
	if !e.memoryExtractOn() {
		return
	}
	if _, running := e.memoryExtractions.LoadOrStore(cause, true); running {
		return
	}
	defer e.memoryExtractions.Delete(cause)
	ctx, cancel := context.WithTimeout(e.ctx, 15*time.Second)
	defer cancel()
	previous, err := e.store.Find(ctx, store.Query{Scope: event.Scope{Group: card.Group, Task: card.ID}, Types: []event.Type{memory.Extracted}})
	if err != nil {
		return
	}
	for _, fact := range previous {
		if fact.Cause == cause {
			return
		}
	}
	for i := len(card.Claims) - 1; i >= 0; i-- {
		claim := card.Claims[i]
		if claim.Report == nil {
			continue
		}
		member, err := e.groupMember(ctx, card.Group, claim.Member)
		if err != nil {
			return
		}
		p, err := e.memberAgent(ctx, member)
		if err != nil {
			return
		}
		ref := p.Model
		if e.provider(ref.Provider) == nil {
			leaderMember, err := e.groupLeader(ctx, card.Group)
			if err == nil {
				leaderProfile, err := e.memberAgent(ctx, leaderMember)
				if err == nil {
					ref = leaderProfile.Model
				}
			}
		}
		ref = e.extractorModel(ref)
		provider := e.provider(ref.Provider)
		if provider == nil {
			return
		}
		scope := event.Scope{Group: card.Group, Task: card.ID}
		owners := e.memberMemoryOwners(ctx, e.workdir, scope, member.ID)
		if len(owners) == 0 {
			return
		}
		facts, err := e.store.Find(ctx, store.Query{Scope: scope, Types: []event.Type{group.HumanSaid, session.MessageSent, session.MessageCompleted}})
		if err != nil {
			return
		}
		var transcript []model.Message
		for _, fact := range facts {
			if fact.Type == group.HumanSaid {
				message, err := event.Decode[group.Message](fact)
				if err == nil {
					transcript = append(transcript, model.Message{Role: model.User, Parts: []model.Part{{Text: message.Text}}})
				}
				continue
			}
			message, err := event.Decode[model.Message](fact)
			if err == nil {
				// Extraction receives text only, never executable calls or unmatched results.
				var parts []model.Part
				for _, part := range message.Parts {
					if part.Text != "" {
						parts = append(parts, model.Part{Text: part.Text})
					}
				}
				if len(parts) > 0 {
					transcript = append(transcript, model.Message{Role: message.Role, Parts: parts})
				}
			}
		}
		report, _ := json.Marshal(card)
		transcript = append(transcript, model.Message{Role: model.User, Parts: []model.Part{{Text: string(report)}}})
		limit := max(0, e.catalog.Get(ref.Provider, ref.Model).Window-4096)
		for len(transcript) > 1 {
			body, _ := json.Marshal(transcript)
			if window.EstimateText(string(body)) <= limit {
				break
			}
			transcript = transcript[1:]
		}
		result := memory.Extraction{}
		extractor := memory.ModelExtractor{Provider: provider, Model: ref.Model, OnUsage: func(usage model.Usage) { result.Usage = usage }}
		notes, err := extractor.Extract(ctx, transcript)
		result.Failed = err != nil
		if err == nil {
			for index, note := range notes {
				note.Scope, note.Owner, note.Source = owners[0].Scope, owners[0].ID, card.ID
				note.ID, note.Created = event.ID(string(cause)+"/"+strconv.Itoa(index)), e.now()
				if _, err := e.notes.Remember(ctx, note); err == nil || errors.Is(err, store.ErrConflict) {
					result.Stored++
				}
			}
		}
		body, _ := json.Marshal(result)
		_, _ = e.Bus.Publish(ctx, event.Event{Stream: event.Stream("group:" + card.Group), Type: memory.Extracted, Scope: scope, Actor: event.Actor{Kind: event.ActorAgent, ID: member.ID}, Cause: cause, Payload: body})
		return
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
func (e *Engine) ConfigureMemory(settings MemorySettings) {
	e.memoryExtractOff.Store(!settings.AutoExtract)
	e.memoryRecallOff.Store(!settings.AutoRecall)
	provider, name, found := strings.Cut(settings.Model, "/")
	if !found || provider == "" || name == "" {
		e.memoryModel.Store(nil)
		return
	}
	e.memoryModel.Store(&agent.ModelRef{Provider: provider, Model: name})
}

// extractorModel is the model that writes notes: the memory-extractor entry of the agent section, else memory.model,
// else own.
func (e *Engine) extractorModel(own agent.ModelRef) agent.ModelRef {
	if ref, ok := e.configuredJobModel("memory-extractor"); ok {
		return ref
	}
	if ref := e.memoryModel.Load(); ref != nil {
		return *ref
	}
	return own
}

func (e *Engine) memoryExtractOn() bool { return !e.memoryExtractOff.Load() }
func (e *Engine) memoryRecallOn() bool  { return !e.memoryRecallOff.Load() }

// MemoryList returns the notes of a project, or of one scope of it, newest first. The scope is "project" (the
// default), "group" or "member".
func (e *Engine) MemoryList(ctx context.Context, directory, scope string) ([]memory.Note, error) {
	if scope == "" || scope == string(memory.ScopeProject) {
		notes, err := e.notes.List(ctx, []memory.Owner{memory.ProjectOwner(e.directory(directory))})
		return notes, err
	}
	if scope != string(memory.ScopeGroup) && scope != string(memory.ScopeMember) {
		return nil, errors.New("unknown memory scope")
	}
	all, err := e.notes.List(ctx, nil)
	if err != nil {
		return nil, err
	}
	notes := []memory.Note{}
	for _, note := range all {
		if string(note.Scope) == scope {
			notes = append(notes, note)
		}
	}
	return notes, nil
}

// MemoryRead returns one note.
func (e *Engine) MemoryRead(ctx context.Context, id event.ID) (memory.Note, error) {
	if strings.TrimSpace(string(id)) == "" {
		return memory.Note{}, errors.New("a note id is required")
	}
	return e.notes.Read(ctx, id)
}

// MemoryDelete removes one note.
func (e *Engine) MemoryDelete(ctx context.Context, id event.ID) error {
	return e.notes.Delete(ctx, id)
}

// ConfigureRules sets the personal rules of the user; they come before the project's rules in the prompt of
// every conversation started afterwards.
func (e *Engine) ConfigureRules(personal []string) {
	copied := append([]string(nil), personal...)
	e.personal.Store(&copied)
}

func (e *Engine) personalRules() []string {
	if rules := e.personal.Load(); rules != nil {
		return *rules
	}
	return nil
}
