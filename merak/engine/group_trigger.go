package engine

import (
	"context"
	"encoding/json"
	"errors"
	"strings"

	"github.com/TongTong313/merakcode/merak/engine/event"
	"github.com/TongTong313/merakcode/merak/engine/group"
	"github.com/TongTong313/merakcode/merak/engine/leader"
	"github.com/TongTong313/merakcode/merak/engine/task"
)

func triggerActor(actor event.Actor) bool {
	return actor.Kind == "system" && strings.HasPrefix(string(actor.ID), "trigger:")
}

func environmental(fact event.Event) bool {
	return fact.Actor.Kind == event.ActorExternal && (fact.Type == RepoChanged || fact.Type == FileChanged || strings.HasPrefix(string(fact.Type), "external."))
}

func (e *Engine) routeEnvironment(ctx context.Context, run *groupRun, fact event.Event) error {
	cards, err := e.Tasks.List(ctx, run.group.ID)
	if err != nil {
		return err
	}
	targets := leader.EnvironmentTargets(fact, cards)
	if len(targets) == 0 && !leader.EnvironmentHasExternal(fact) {
		run.threads.Route(fact).Scheduler.Inform(fact)
		return nil
	}
	priority := leader.PriorityLow
	if len(targets) > 0 || run.group.Settings.Initiative == group.Eager {
		priority = leader.PriorityNormal
	}
	if len(targets) == 0 {
		targets = []event.ID{fact.Scope.Task}
	}
	for _, target := range targets {
		routed := fact
		routed.Scope.Task = target
		thread := run.threads.Route(routed)
		thread.Scheduler.EnqueuePriority(routed, priority)
		e.startLeader(run, thread)
	}
	return nil
}

func (e *Engine) applyTriggers(ctx context.Context, run *groupRun, fact event.Event) (bool, error) {
	if triggerActor(fact.Actor) {
		run.threads.Route(fact).Scheduler.Inform(fact)
		return true, nil
	}
	actions, handled := run.triggers.Evaluate(fact, e.now())
	if !handled {
		return false, nil
	}
	var priority leader.Priority
	wake := false
	for _, triggered := range actions {
		action := triggered.Action
		switch action.Kind {
		case leader.CreateTask:
			if triggered.Rule == leader.IntegrationTrigger {
				if err := e.createIntegrationTask(ctx, run, fact); err != nil {
					return true, err
				}
				continue
			}
			card := task.Card{Group: run.group.ID, Parent: fact.Scope.Task, Title: action.Template, CreatedBy: event.Actor{Kind: "system", ID: "trigger:" + triggered.Rule}}
			if _, err := e.createTask(ctx, card, action.Member); err != nil {
				return true, err
			}
		case leader.NotifyHuman:
			state, err := e.Groups.Get(ctx, run.group.ID)
			if err != nil {
				return true, err
			}
			var to []event.ID
			for _, member := range state.Members {
				if member.Can(group.RoleOwner) {
					to = append(to, member.ID)
				}
			}
			body, _ := json.Marshal(group.Notice{Kind: "info", Text: action.Template, To: to})
			if _, err := e.Bus.Publish(ctx, event.Event{Stream: fact.Stream, Scope: fact.Scope, Type: group.NoticeSent, Actor: event.Actor{Kind: "system", ID: "trigger:" + triggered.Rule}, Cause: fact.ID, Payload: body}); err != nil {
				return true, err
			}
		case leader.AssignMember:
			card, err := e.Tasks.Get(ctx, fact.Scope.Task)
			if err != nil {
				return true, err
			}
			if card.Group != run.group.ID {
				return true, errors.New("assignment trigger task belongs to another group")
			}
			if _, err := e.Tasks.AssignAs(ctx, card.ID, action.Member, task.RoleOwner, card.Areas, event.Actor{Kind: "system", ID: "trigger:" + triggered.Rule}); err != nil {
				return true, err
			}
		case leader.WakeLeader:
			wake, priority = true, max(priority, action.Priority)
		}
	}
	if thread := run.threads.Route(fact); thread != nil {
		if wake {
			thread.Scheduler.EnqueuePriority(fact, priority)
			e.startLeader(run, thread)
		} else {
			thread.Scheduler.Inform(fact)
		}
	}
	return true, nil
}

func (e *Engine) routeTaskChange(ctx context.Context, run *groupRun, fact event.Event) bool {
	if fact.Type != task.Closed && fact.Type != task.PhaseChanged {
		return false
	}
	card, err := event.Decode[task.Card](fact)
	if err != nil {
		return false
	}
	priority := leader.PriorityHigh
	routed := fact
	if fact.Type == task.Closed {
		if card.Status != task.Cancelled || fact.Actor.Kind != event.ActorHuman {
			return false
		}
		if card.Parent != "" {
			root, err := e.taskRoot(ctx, card)
			ancestor, loadErr := e.Tasks.Get(ctx, root)
			if err == nil && loadErr == nil && ancestor.Status == task.Cancelled {
				return true
			}
		}
		routed.Scope.Task = ""
		priority = leader.PriorityUrgent
	} else if card.Phase != task.PhaseStalled {
		return false
	}
	thread := run.threads.Route(routed)
	thread.Scheduler.EnqueuePriority(routed, priority)
	e.startLeader(run, thread)
	return true
}
