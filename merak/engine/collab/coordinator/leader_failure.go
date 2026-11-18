package coordinator

import (
	"context"
	"encoding/json"
	"time"

	"github.com/TongTong313/merakcode/merak/engine/collab/group"
	"github.com/TongTong313/merakcode/merak/engine/collab/leader"
	"github.com/TongTong313/merakcode/merak/engine/infra/event"
)

func (domain *Coordinator) pauseLeader(ctx context.Context, groupID event.ID, thread *leader.Thread) {
	ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	body, _ := json.Marshal(group.Control{Thread: thread.Key, Session: thread.Session.Read().ID, Code: "MRK-4004"})
	fact, err := domain.core.Bus.Publish(ctx, event.Event{Stream: event.Stream("group:" + groupID), Scope: thread.Session.Read().Scope, Type: "group.paused", Actor: event.Actor{Kind: event.ActorAgent, ID: thread.Leader}, Payload: body})
	if err != nil {
		return
	}
	state, err := domain.groups.Get(ctx, groupID)
	if err != nil {
		return
	}
	var to []event.ID
	for _, member := range state.Members {
		if member.Can(group.RoleOwner) {
			to = append(to, member.ID)
		}
	}
	body, _ = json.Marshal(group.Notice{Kind: "blocked", Text: "MRK-4004", To: to})
	_, _ = domain.core.Bus.Publish(ctx, event.Event{Stream: fact.Stream, Scope: fact.Scope, Type: group.NoticeSent, Actor: fact.Actor, Cause: fact.ID, Payload: body})
}
