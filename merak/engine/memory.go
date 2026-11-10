package engine

import (
	"context"
	"encoding/json"
	"errors"
	"strconv"
	"time"

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
	provider := e.provider(c.state.Config.Provider)
	if provider == nil {
		return
	}
	extractor := memory.ModelExtractor{Provider: provider, Model: c.state.Config.Model, OnUsage: func(usage model.Usage) { result.Usage = usage }}
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
		p, err := e.memberProfile(ctx, member)
		if err != nil {
			return
		}
		ref := p.Model
		if e.provider(ref.Provider) == nil {
			leaderMember, err := e.groupMember(ctx, card.Group, card.Leader)
			if err == nil {
				leaderProfile, err := e.memberProfile(ctx, leaderMember)
				if err == nil {
					ref = leaderProfile.Model
				}
			}
		}
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
