package migrate

import (
	"encoding/json"
	"errors"
	"strings"
	"time"

	"github.com/TongTong313/merakcode/merak/engine/agent"
	"github.com/TongTong313/merakcode/merak/engine/event"
	"github.com/TongTong313/merakcode/merak/engine/group"
	"github.com/TongTong313/merakcode/merak/engine/model"
	"github.com/TongTong313/merakcode/merak/engine/session"
)

// importGroup turns the chat and the record of a collaboration group of v0.3 into an archived group of v1: its
// members are the seats, matched to agents by name, and its messages keep their times. Nobody can say anything in
// it any more.
func (r *run) importGroup(info v03Session) {
	records, err := r.db.records(r.ctx, "collaboration/"+info.ID)
	var stored v03Group
	found := false
	for _, row := range records {
		if row.ID != "" {
			continue
		}
		found = true
		if stored, err = decode[v03Group]("group record", info.ID, row.Data); err != nil {
			r.skip("group", info.ID, codeRecord, err)
			return
		}
	}
	if !found || len(stored.Seats) == 0 {
		r.skip("group", info.ID, codeRecord, errors.New("the group has no record of its members"))
		return
	}
	if _, listed := r.todos[info.ID]; listed {
		r.skip("todo", info.ID, codeRecord, errors.New("the todo list of a group has no equivalent"))
	}
	chat, err := load(r.ctx, r.db, info)
	if err != nil {
		r.skip("group", info.ID, codeSession, err)
		return
	}
	id := event.NewID()
	members, leader, err := r.groupMembers(id, stored)
	if err != nil {
		r.skip("group", info.ID, codeRecord, err)
		return
	}
	name := strings.TrimSpace(info.Title)
	if name == "" {
		name = info.ID
	}
	created := ms(info.Time.Created)
	facts := []event.Event{r.groupFact(id, 1, created, group.Created, event.Actor{Kind: event.ActorHuman, ID: r.m.options.Human}, group.State{
		Group:   group.Group{ID: id, Kind: group.KindLocal, Name: name, Project: group.Project{Directory: info.Directory}, Leader: leader, Archived: true},
		Members: members,
	})}
	messages := 0
	for _, one := range chat.messages {
		var text strings.Builder
		for _, part := range one.parts {
			if part.Type == "text" && !part.Ignored && !part.Synthetic {
				text.WriteString(part.Text)
			}
		}
		if strings.TrimSpace(text.String()) == "" {
			continue
		}
		seq, at := uint64(len(facts)+1), ms(one.info.Time.Created)
		switch {
		case one.info.Role == "user":
			facts = append(facts, r.groupFact(id, seq, at, group.HumanSaid, event.Actor{Kind: event.ActorHuman, ID: r.m.options.Human}, group.Message{Text: text.String()}))
		case one.info.Role == "assistant":
			reply := session.Completion{Message: model.Message{Role: model.Assistant, Parts: []model.Part{{Text: text.String()}}}}
			facts = append(facts, r.groupFact(id, seq, at, session.MessageCompleted, event.Actor{Kind: event.ActorAgent, ID: leader}, reply))
		default:
			continue
		}
		messages++
	}
	for _, fact := range facts {
		if err := r.m.options.Engine.Bus.Import(r.ctx, fact); err != nil {
			r.skip("group", info.ID, codeRecord, err)
			return
		}
	}
	r.record.Groups[info.ID] = string(id)
	r.result.Imported.Groups++
	r.result.Imported.Messages += messages
	r.saved()
}

func (r *run) groupFact(id event.ID, seq uint64, at time.Time, kind event.Type, actor event.Actor, payload any) event.Event {
	body, _ := json.Marshal(payload)
	return event.Event{ID: event.NewID(), Stream: event.Stream("group:" + id), Seq: seq, Time: at, Type: kind, Scope: event.Scope{Group: id}, Actor: actor, Payload: body}
}

// groupMembers makes the owner and one agent member of each seat, and returns the id of the Leader.
func (r *run) groupMembers(id event.ID, stored v03Group) ([]group.Member, event.ID, error) {
	listed, err := r.m.options.Engine.ListAgents(r.ctx, r.m.options.Human)
	if err != nil {
		return nil, "", err
	}
	members := []group.Member{{ID: r.m.options.Human, Group: id, Kind: group.MemberHuman, Name: "Owner", Role: group.RoleOwner, Status: group.Idle}}
	var leader event.ID
	for _, seat := range stored.Seats {
		if strings.TrimSpace(seat.Name) == "" {
			return nil, "", errors.New("a seat has no name")
		}
		role, builtin := group.AgentWorker, event.ID("builtin-worker")
		if seat.Leader {
			role, builtin = group.AgentLeader, "builtin-leader"
		}
		member := group.Member{ID: event.NewID(), Group: id, Kind: group.MemberAgent, Name: seat.Name, Role: seat.Role, Summary: seat.Duty, AgentRole: role, Owner: r.m.options.Human, Agent: r.seatAgent(seat, role, builtin, listed), Status: group.Offline}
		if seat.Leader && leader == "" {
			leader = member.ID
		}
		members = append(members, member)
	}
	if leader == "" {
		return nil, "", errors.New("the group has no Leader seat")
	}
	return members, leader, nil
}

// seatAgent finds the agent of a seat: the agent that has the seat's name and role, else the imported agent of the
// seat's product, else the built-in agent of its role.
func (r *run) seatAgent(seat v03Seat, role group.AgentRole, builtin event.ID, listed []agent.Agent) event.ID {
	want := agent.Role(role)
	for _, candidate := range listed {
		if candidate.Role == want && strings.EqualFold(candidate.Name, seat.Name) {
			return candidate.ID
		}
	}
	if id := r.record.Agents["product:"+seat.Product]; id != "" && role == group.AgentWorker {
		return event.ID(id)
	}
	return builtin
}
