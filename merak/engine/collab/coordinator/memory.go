package coordinator

import (
	"context"
	"encoding/json"
	"errors"
	"strconv"
	"time"

	"github.com/TongTong313/merakcode/merak/engine/agent/memory"
	"github.com/TongTong313/merakcode/merak/engine/agent/model"
	"github.com/TongTong313/merakcode/merak/engine/agent/session"
	"github.com/TongTong313/merakcode/merak/engine/agent/window"
	"github.com/TongTong313/merakcode/merak/engine/collab/group"
	"github.com/TongTong313/merakcode/merak/engine/collab/task"
	"github.com/TongTong313/merakcode/merak/engine/infra/event"
	"github.com/TongTong313/merakcode/merak/engine/infra/store"
)

func (domain *Coordinator) extractTaskMemory(card task.Card, cause event.ID) {
	if !domain.conversation.MemoryExtractOn() {
		return
	}
	if !domain.conversation.BeginMemoryExtraction(cause) {
		return
	}
	defer domain.conversation.EndMemoryExtraction(cause)
	ctx, cancel := context.WithTimeout(domain.core.Ctx, 15*time.Second)
	defer cancel()
	previous, err := domain.core.Store.Find(ctx, store.Query{Scope: event.Scope{Group: card.Group, Task: card.ID}, Types: []event.Type{memory.Extracted}})
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
		member, err := domain.roster.GroupMember(ctx, card.Group, claim.Member)
		if err != nil {
			return
		}
		p, err := domain.roster.MemberAgent(ctx, member)
		if err != nil {
			return
		}
		ref := p.Model
		if domain.registry.Provider(ref.Provider) == nil {
			leaderMember, err := domain.roster.GroupLeader(ctx, card.Group)
			if err == nil {
				leaderProfile, err := domain.roster.MemberAgent(ctx, leaderMember)
				if err == nil {
					ref = leaderProfile.Model
				}
			}
		}
		ref = domain.conversation.ExtractorModel(ref)
		provider := domain.registry.Provider(ref.Provider)
		if provider == nil {
			return
		}
		scope := event.Scope{Group: card.Group, Task: card.ID}
		owners := domain.roster.MemberMemoryOwners(ctx, domain.core.Workdir, scope, member.ID)
		if len(owners) == 0 {
			return
		}
		facts, err := domain.core.Store.Find(ctx, store.Query{Scope: scope, Types: []event.Type{group.HumanSaid, session.MessageSent, session.MessageCompleted}})
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
		limit := max(0, domain.catalog.Get(ref.Provider, ref.Model).Window-4096)
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
				note.ID, note.Created = event.ID(string(cause)+"/"+strconv.Itoa(index)), domain.core.Now()
				if _, err := domain.notes.Remember(ctx, note); err == nil || errors.Is(err, store.ErrConflict) {
					result.Stored++
				}
			}
		}
		body, _ := json.Marshal(result)
		_, _ = domain.core.Bus.Publish(ctx, event.Event{Stream: event.Stream("group:" + card.Group), Type: memory.Extracted, Scope: scope, Actor: event.Actor{Kind: event.ActorAgent, ID: member.ID}, Cause: cause, Payload: body})
		return
	}
}
