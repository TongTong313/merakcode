package engine

import (
	"context"
	"encoding/json"
	"slices"
	"strings"

	"github.com/TongTong313/merakcode/merak/engine/event"
	"github.com/TongTong313/merakcode/merak/engine/group"
	"github.com/TongTong313/merakcode/merak/engine/memory"
	"github.com/TongTong313/merakcode/merak/engine/profile"
	"github.com/TongTong313/merakcode/merak/engine/session"
	"github.com/TongTong313/merakcode/merak/engine/store"
	"github.com/TongTong313/merakcode/merak/engine/window"
	"github.com/TongTong313/merakcode/merak/engine/worker"
)

func (e *Engine) prepareTaskPacket(ctx context.Context, p *profile.Profile, a *worker.Assignment) ([]event.ID, error) {
	if a.Scope.Group == "" || a.Claim.Task == "" || a.Leader {
		return nil, nil
	}
	state, err := e.Groups.Get(ctx, a.Scope.Group)
	if err != nil {
		return nil, err
	}
	type memberRole struct {
		ID   event.ID `json:"id"`
		Name string   `json:"name"`
		Role string   `json:"role"`
	}
	roles := make([]memberRole, 0, len(state.Members))
	for _, m := range state.Members {
		role := m.Role
		if m.Kind == group.MemberAgent {
			role = string(m.AgentRole)
		}
		roles = append(roles, memberRole{m.ID, m.Name, role})
	}
	brief, _ := json.Marshal(struct {
		Name    string       `json:"name"`
		Brief   group.Brief  `json:"brief"`
		Members []memberRole `json:"members"`
	}{state.Group.Name, state.Group.Brief, roles})
	p.System += "\nGroup brief:\n" + string(brief)
	if _, hosted := e.hostedGroups.Load(a.Scope.Group); hosted {
		return nil, nil
	}
	card, err := e.Tasks.Get(ctx, a.Claim.Task)
	if err != nil {
		return nil, err
	}
	packet := window.Packet{Task: card, Claim: a.Claim, Goal: card.Title, Instruction: a.Packet}
	for parent := card.Parent; parent != ""; {
		root, err := e.Tasks.Get(ctx, parent)
		if err != nil {
			return nil, err
		}
		packet.Goal, parent = root.Title, root.Parent
	}
	facts, err := e.store.Find(ctx, store.Query{Scope: event.Scope{Group: card.Group}, Types: []event.Type{group.HumanSaid, session.MessageCompleted}})
	if err != nil {
		return nil, err
	}
	addressed := make(map[event.ID]bool)
	for _, fact := range facts {
		var text string
		relevant := fact.Scope.Task == card.ID || slices.Contains(card.Discussion, fact.ID)
		if fact.Type == group.HumanSaid {
			message, err := event.Decode[group.Message](fact)
			if err != nil {
				continue
			}
			text = message.Text
			relevant = relevant || slices.Contains(message.To, a.Claim.Member)
			addressed[fact.ID] = slices.Contains(message.To, a.Claim.Member) || len(message.To) == 0 && fact.Scope.Task == card.ID
		} else {
			if fact.Stream != event.Stream("group:"+card.Group) {
				continue
			}
			message, err := event.Decode[session.Completion](fact)
			if err != nil {
				continue
			}
			for _, part := range message.Parts {
				text += part.Text
			}
		}
		if relevant || strings.Contains(text, string(card.ID)) || strings.Contains(text, "@"+string(a.Claim.Member)) {
			packet.Dialogue = append(packet.Dialogue, window.Excerpt{ID: fact.ID, Actor: fact.Actor, Text: text})
		}
	}
	owners := e.memberMemoryOwners(ctx, a.Workdir, a.Scope, a.Claim.Member)
	packet.Memory, err = e.notes.Recall(ctx, memory.Query{Owners: owners, Text: card.Title + " " + card.Description, Tags: card.Areas})
	if err != nil {
		return nil, err
	}
	if len(packet.Memory) == 0 {
		packet.Memory, err = e.notes.Recall(ctx, memory.Query{Owners: owners, Limit: 5})
		if err != nil {
			return nil, err
		}
	}
	docs, err := e.ListGroupDocuments(ctx, card.Group)
	if err != nil {
		return nil, err
	}
	for _, doc := range docs {
		packet.Docs = append(packet.Docs, window.DocRef{Key: doc.Key, Title: doc.Title})
	}
	for _, id := range card.Deps {
		dep, err := e.Tasks.Get(ctx, id)
		if err != nil {
			return nil, err
		}
		for _, claim := range dep.Claims {
			if claim.Report != nil {
				packet.Inputs = append(packet.Inputs, window.ReportRef{Ref: "mrk://group/" + string(card.Group) + "/task/" + string(id), Report: claim.Report})
			}
		}
	}
	chosen, err := e.memberModel(p.Model)
	if err != nil {
		chosen = p.Model
	}
	entry := e.catalog.Get(chosen.Provider, chosen.Model)
	budget := max(0, entry.Window-max(entry.MaxOutput/4, 8192)-window.EstimateText(p.System))
	a.Packet, err = packet.Render(budget)
	var sources []event.ID
	for _, excerpt := range packet.Dialogue {
		if addressed[excerpt.ID] {
			sources = append(sources, excerpt.ID)
		}
	}
	return sources, err
}
