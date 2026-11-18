package execution

import (
	"context"
	"encoding/json"
	"math"
	"time"

	"github.com/TongTong313/merakcode/merak/engine/agent/conversation"
	"github.com/TongTong313/merakcode/merak/engine/agent/definition"
	"github.com/TongTong313/merakcode/merak/engine/agent/loop"
	"github.com/TongTong313/merakcode/merak/engine/agent/model"
	"github.com/TongTong313/merakcode/merak/engine/agent/session"
	"github.com/TongTong313/merakcode/merak/engine/collab/group"
	"github.com/TongTong313/merakcode/merak/engine/collab/task"
	"github.com/TongTong313/merakcode/merak/engine/infra/event"
	"github.com/TongTong313/merakcode/merak/engine/infra/store"
)

type resolvedExecutionBudget struct {
	member definition.Budget
	task   task.Budget
}

func (domain *Execution) resolveExecutionBudget(ctx context.Context, scope event.Scope, member event.ID, limits definition.Budget) (resolvedExecutionBudget, error) {
	var card task.Card
	if scope.Task != "" && scope.Group != "" {
		var err error
		card, err = domain.tasks.Get(ctx, scope.Task)
		if err != nil {
			return resolvedExecutionBudget{}, err
		}
		limits = grantedBudget(limits, card.Grants)
		card.Budget = task.Budget(grantedBudget(session.Budget(card.Budget), card.Grants))
		if current, err := domain.roster.GroupMember(ctx, scope.Group, member); err == nil && current.AgentRole == group.AgentLeader {
			card.Budget = task.Budget{}
		}
	}
	return resolvedExecutionBudget{member: limits, task: card.Budget}, nil
}

// executionBudget reads durable usage so rework and replacement sessions share a task's limits.
func (domain *Execution) executionBudget(ctx context.Context, scope event.Scope, member event.ID, limits definition.Budget) (loop.StopReason, time.Time, error) {
	resolved, err := domain.resolveExecutionBudget(ctx, scope, member, limits)
	if err != nil {
		return "", time.Time{}, err
	}
	return domain.checkExecutionBudget(ctx, scope, member, resolved)
}

func (domain *Execution) checkExecutionBudget(ctx context.Context, scope event.Scope, member event.ID, resolved resolvedExecutionBudget) (loop.StopReason, time.Time, error) {
	limits, taskBudget := resolved.member, resolved.task
	if limits.MaxTokens == 0 && limits.MaxCost == 0 && limits.MaxWallClock == 0 && taskBudget == (task.Budget{}) {
		return "", time.Time{}, nil
	}
	total, personal, err := domain.readBudgetUsage(ctx, scope, member)
	if err != nil {
		return "", time.Time{}, err
	}
	started, taskStarted := personal.started, total.started
	var deadline time.Time
	if limits.MaxWallClock > 0 {
		if started.IsZero() {
			started = domain.core.Now()
		}
		deadline = started.Add(limits.MaxWallClock)
	}
	if taskBudget.MaxWallClock > 0 {
		if taskStarted.IsZero() {
			taskStarted = domain.core.Now()
		}
		taskDeadline := taskStarted.Add(taskBudget.MaxWallClock)
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
	if !deadline.IsZero() && !domain.core.Now().Before(deadline) {
		return loop.MaxWallClock, deadline, nil
	}
	if scope.Task != "" && scope.Group != "" {
		if taskBudget.MaxTokens > 0 && total.Tokens >= taskBudget.MaxTokens {
			return loop.MaxTokens, deadline, nil
		}
		if taskBudget.MaxCost > 0 && total.Cost >= taskBudget.MaxCost {
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
func (domain *Execution) readBudgetUsage(ctx context.Context, scope event.Scope, member event.ID) (total, personal budgetUsage, err error) {
	query := event.Scope{Session: scope.Session}
	if scope.Group != "" && scope.Task != "" {
		query = event.Scope{Group: scope.Group, Task: scope.Task}
	}
	facts, err := domain.core.Store.Find(ctx, store.Query{Scope: query, Types: []event.Type{session.Created, session.MessageCompleted, session.Rebuilt}})
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
			used.WallClock = max(0, domain.core.Now().Sub(used.started))
		}
	}
	return total, personal, nil
}

func (domain *Execution) BlockBudgetTask(ctx context.Context, scope event.Scope) {
	if scope.Task == "" {
		return
	}
	ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	card, err := domain.tasks.Get(ctx, scope.Task)
	if err != nil || card.Status == task.Blocked {
		return
	}
	if domain.tasks.Block(ctx, card.ID) != nil {
		return
	}
	state, err := domain.groups.Get(ctx, card.Group)
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
	_, _ = domain.core.Bus.Publish(ctx, event.Event{Stream: event.Stream("group:" + card.Group), Scope: scope, Type: group.NoticeSent, Actor: domain.roster.LeaderActor(ctx, card), Payload: body})
}

func (domain *Execution) configureExecutionBudget(ctx context.Context, c *conversation.Conversation) error {
	state := c.State.Read()
	scope, member, limits := state.Scope, state.Config.Member, state.Config.Budget
	for i := 0; i < state.BudgetExtensions; i++ {
		base := state.Config.Budget
		limits = grantedBudget(limits, []task.Grant{{BudgetIncrease: task.BudgetIncrease{Tokens: base.MaxTokens, Cost: base.MaxCost, WallClock: base.MaxWallClock}}})
	}
	scope.Session = state.ID
	_, deadline, err := domain.executionBudget(ctx, scope, member, limits)
	if err != nil {
		return err
	}
	c.State.SetBudgetDeadline(deadline)
	c.Runner.Limits.MaxTokens, c.Runner.Limits.MaxCost = 0, 0
	if !deadline.IsZero() {
		c.Runner.Limits.MaxWallClock = 1
	}
	c.Runner.Budget = func(ctx context.Context) (loop.StopReason, error) {
		stop, _, err := domain.executionBudget(ctx, scope, member, limits)
		return stop, err
	}
	c.Runner.Deadline = func(ctx context.Context) (time.Time, error) {
		_, deadline, err := domain.executionBudget(ctx, scope, member, limits)
		return deadline, err
	}
	return nil
}

// conversationBudget configures the turn and returns its existing result handler.
func (domain *Execution) ConversationBudget(ctx context.Context, c *conversation.Conversation) (func(loop.Outcome), error) {
	if err := domain.configureExecutionBudget(ctx, c); err != nil {
		return nil, err
	}
	return func(outcome loop.Outcome) {
		if loop.BudgetStop(outcome.Stop) {
			domain.BlockBudgetTask(context.WithoutCancel(ctx), c.State.Read().Scope)
		}
	}, nil
}
