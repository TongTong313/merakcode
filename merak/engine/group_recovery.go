package engine

import (
	"context"
	"slices"

	"github.com/TongTong313/merakcode/merak/engine/event"
	"github.com/TongTong313/merakcode/merak/engine/group"
	"github.com/TongTong313/merakcode/merak/engine/leader"
	"github.com/TongTong313/merakcode/merak/engine/permission"
	"github.com/TongTong313/merakcode/merak/engine/question"
	"github.com/TongTong313/merakcode/merak/engine/session"
	"github.com/TongTong313/merakcode/merak/engine/store"
	"github.com/TongTong313/merakcode/merak/engine/task"
	"github.com/TongTong313/merakcode/merak/engine/workspace"
)

func leaderInputType(kind event.Type) bool {
	switch kind {
	case SentinelFlagged, permission.Routed, task.Progressed, group.MemberAsked, question.Answered, task.Opened, task.Reported, workspace.MergeDone, workspace.MergeConflicted, group.HumanSaid, task.Reviewed:
		return true
	}
	return false
}

// restoreLeaderInputs rebuilds pending deliveries without repeating trigger actions.
func (e *Engine) restoreLeaderInputs(ctx context.Context, run *groupRun) error {
	facts, err := e.store.Find(ctx, store.Query{Scope: event.Scope{Group: run.group.ID}})
	if err != nil {
		return err
	}
	delivered := map[event.ID]map[event.ID]bool{}
	for _, fact := range facts {
		if fact.Type != session.MessageSent {
			continue
		}
		input, err := event.Decode[session.Input](fact)
		if err != nil {
			return err
		}
		key := run.state.Root(fact.Scope.Task)
		if fact.Scope.Task == "" {
			key = run.group.ID
		}
		if delivered[key] == nil {
			delivered[key] = map[event.ID]bool{}
		}
		delivered[key][fact.Cause] = true
		for _, source := range input.Sources {
			delivered[key][source] = true
		}
	}
	for _, fact := range facts {
		if fact.Stream != event.Stream("group:"+run.group.ID) || fact.Seq > run.seq {
			continue
		}
		actions, handled := run.triggers.Evaluate(fact, fact.Time)
		wake, priority := false, leader.PriorityLow
		for _, action := range actions {
			if action.Action.Kind == leader.WakeLeader {
				wake, priority = true, max(priority, action.Action.Priority)
			}
		}
		if handled && !wake || !handled && !leaderInputType(fact.Type) {
			continue
		}
		thread := run.threads.Route(fact)
		if thread == nil || delivered[thread.Key][fact.ID] {
			continue
		}
		if fact.Scope.Task != "" {
			card, err := e.Tasks.Get(ctx, fact.Scope.Task)
			if err != nil {
				return err
			}
			if card.Status == task.Done || card.Status == task.Cancelled || card.Status == task.Failed {
				continue
			}
			if fact.Type == task.Opened && (card.Parent != "" || len(card.Claims) > 0 || triggerActor(card.CreatedBy)) {
				continue
			}
			if fact.Type == group.HumanSaid && slices.Contains(card.Discussion, fact.ID) {
				continue
			}
		}
		if fact.Type == group.HumanSaid {
			message, err := event.Decode[group.Message](fact)
			if err != nil {
				return err
			}
			if len(message.To) > 0 && !slices.Contains(message.To, thread.Leader) {
				continue
			}
		}
		if handled {
			thread.Scheduler.EnqueuePriority(fact, priority)
		} else {
			thread.Scheduler.Enqueue(fact)
		}
	}
	return nil
}
