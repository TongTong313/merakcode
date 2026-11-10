package engine

import (
	"context"
	"encoding/json"
	"math"
	"time"

	"github.com/TongTong313/merakcode/merak/engine/event"
	"github.com/TongTong313/merakcode/merak/engine/group"
	"github.com/TongTong313/merakcode/merak/engine/loop"
	"github.com/TongTong313/merakcode/merak/engine/model"
	"github.com/TongTong313/merakcode/merak/engine/profile"
	"github.com/TongTong313/merakcode/merak/engine/session"
	"github.com/TongTong313/merakcode/merak/engine/store"
	"github.com/TongTong313/merakcode/merak/engine/task"
)

// executionBudget reads durable usage so rework and replacement sessions share a task's limits.
func (e *Engine) executionBudget(ctx context.Context, scope event.Scope, member event.ID, limits profile.Budget) (loop.StopReason, time.Time, error) {
	var card task.Card
	if scope.Task != "" && scope.Group != "" {
		var err error
		card, err = e.Tasks.Get(ctx, scope.Task)
		if err != nil {
			return "", time.Time{}, err
		}
		limits = grantedBudget(limits, card.Grants)
		card.Budget = task.Budget(grantedBudget(session.Budget(card.Budget), card.Grants))
		if current, err := e.groupMember(ctx, scope.Group, member); err == nil && current.AgentRole == group.AgentLeader {
			card.Budget = task.Budget{}
		}
	}
	if limits.MaxTokens == 0 && limits.MaxCost == 0 && limits.MaxWallClock == 0 && card.Budget == (task.Budget{}) {
		return "", time.Time{}, nil
	}
	total, personal, err := e.readBudgetUsage(ctx, scope, member)
	if err != nil {
		return "", time.Time{}, err
	}
	started, taskStarted := personal.started, total.started
	var deadline time.Time
	if limits.MaxWallClock > 0 {
		if started.IsZero() {
			started = e.now()
		}
		deadline = started.Add(limits.MaxWallClock)
	}
	if card.Budget.MaxWallClock > 0 {
		if taskStarted.IsZero() {
			taskStarted = e.now()
		}
		taskDeadline := taskStarted.Add(card.Budget.MaxWallClock)
		if deadline.IsZero() || taskDeadline.Before(deadline) {
			deadline = taskDeadline
		}
	}
	if limits.MaxTokens > 0 && personal.Tokens >= limits.MaxTokens {
		return loop.MaxTokens, deadline, nil
	}
	if limits.MaxCost > 0 && personal.Cost >= limits.MaxCost {
		return loop.MaxCost, deadline, nil
	}
	if !deadline.IsZero() && !e.now().Before(deadline) {
		return loop.MaxWallClock, deadline, nil
	}
	if scope.Task != "" && scope.Group != "" {
		if card.Budget.MaxTokens > 0 && total.Tokens >= card.Budget.MaxTokens {
			return loop.MaxTokens, deadline, nil
		}
		if card.Budget.MaxCost > 0 && total.Cost >= card.Budget.MaxCost {
			return loop.MaxCost, deadline, nil
		}
	}
	return "", deadline, nil
}

func grantedBudget(b session.Budget, grants []task.Grant) session.Budget {
	for _, grant := range grants {
		if b.MaxTokens > 0 {
			b.MaxTokens += min(grant.Tokens, math.MaxInt-b.MaxTokens)
		}
		if b.MaxCost > 0 {
			b.MaxCost += min(grant.Cost, math.MaxFloat64-b.MaxCost)
		}
		if b.MaxWallClock > 0 {
			b.MaxWallClock += min(grant.WallClock, time.Duration(math.MaxInt64)-b.MaxWallClock)
		}
	}
	return b
}

type budgetUsage struct {
	Tokens    int           `json:"tokens"`
	Cost      float64       `json:"cost"`
	WallClock time.Duration `json:"wallClock"`
	started   time.Time
}

// readBudgetUsage is shared by enforcement and the owner's approval details.
func (e *Engine) readBudgetUsage(ctx context.Context, scope event.Scope, member event.ID) (total, personal budgetUsage, err error) {
	query := event.Scope{Session: scope.Session}
	if scope.Group != "" && scope.Task != "" {
		query = event.Scope{Group: scope.Group, Task: scope.Task}
	}
	facts, err := e.store.Find(ctx, store.Query{Scope: query, Types: []event.Type{session.Created, session.MessageCompleted, session.Rebuilt}})
	if err != nil {
		return total, personal, err
	}
	owned, claims := map[event.ID]bool{}, map[event.ID]bool{}
	for _, fact := range facts {
		if fact.Type != session.Created {
			continue
		}
		state, err := event.Decode[session.State](fact)
		if err != nil {
			return total, personal, err
		}
		claims[state.ID] = state.Config.ToolPool != "leader.default"
		owned[state.ID] = state.Config.Member == member || state.ID == scope.Session
		if claims[state.ID] && (total.started.IsZero() || fact.Time.Before(total.started)) {
			total.started = fact.Time
		}
		if owned[state.ID] && (personal.started.IsZero() || fact.Time.Before(personal.started)) {
			personal.started = fact.Time
		}
	}
	for _, fact := range facts {
		if fact.Type == session.Created {
			continue
		}
		// Both completion and rebuild payloads contain the same usage field.
		value, err := event.Decode[struct {
			Usage model.Usage `json:"usage"`
		}](fact)
		if err != nil {
			return total, personal, err
		}
		for _, target := range []struct {
			include bool
			used    *budgetUsage
		}{{claims[fact.Scope.Session], &total}, {owned[fact.Scope.Session], &personal}} {
			if !target.include {
				continue
			}
			target.used.Tokens += value.Usage.Input + value.Usage.Output
			if value.Usage.CostKnown {
				target.used.Cost += value.Usage.Cost
			}
		}
	}
	for _, used := range []*budgetUsage{&total, &personal} {
		if !used.started.IsZero() {
			used.WallClock = max(0, e.now().Sub(used.started))
		}
	}
	return total, personal, nil
}

func (e *Engine) blockBudgetTask(ctx context.Context, scope event.Scope) {
	if scope.Task == "" {
		return
	}
	ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	card, err := e.Tasks.Get(ctx, scope.Task)
	if err != nil || card.Status == task.Blocked {
		return
	}
	if e.Tasks.Block(ctx, card.ID) != nil {
		return
	}
	state, err := e.Groups.Get(ctx, card.Group)
	if err != nil {
		return
	}
	var to []event.ID
	for _, member := range state.Members {
		if member.Can(group.RoleOwner) {
			to = append(to, member.ID)
		}
	}
	body, _ := json.Marshal(group.Notice{Kind: "blocked", Text: card.Title, To: to})
	_, _ = e.Bus.Publish(ctx, event.Event{Stream: event.Stream("group:" + card.Group), Scope: scope, Type: group.NoticeSent, Actor: event.Actor{Kind: event.ActorAgent, ID: card.Leader}, Payload: body})
}

func (e *Engine) configureExecutionBudget(ctx context.Context, c *conversation) error {
	scope, member, limits := c.state.Scope, c.state.Config.Member, c.state.Config.Budget
	for i := 0; i < c.state.BudgetExtensions; i++ {
		base := c.state.Config.Budget
		limits = grantedBudget(limits, []task.Grant{{BudgetIncrease: task.BudgetIncrease{Tokens: base.MaxTokens, Cost: base.MaxCost, WallClock: base.MaxWallClock}}})
	}
	scope.Session = c.state.ID
	_, deadline, err := e.executionBudget(ctx, scope, member, limits)
	if err != nil {
		return err
	}
	c.state.Config.BudgetDeadline = deadline
	c.runner.Limits.MaxTokens, c.runner.Limits.MaxCost = 0, 0
	if !deadline.IsZero() {
		c.runner.Limits.MaxWallClock = 1
	}
	c.runner.Budget = func(ctx context.Context) (loop.StopReason, error) {
		stop, _, err := e.executionBudget(ctx, scope, member, limits)
		return stop, err
	}
	c.runner.Deadline = func(ctx context.Context) (time.Time, error) {
		_, deadline, err := e.executionBudget(ctx, scope, member, limits)
		return deadline, err
	}
	return nil
}
