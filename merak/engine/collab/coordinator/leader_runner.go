package coordinator

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"runtime"
	"strings"
	"time"

	"github.com/TongTong313/merakcode/merak/engine/agent/conversation"
	"github.com/TongTong313/merakcode/merak/engine/agent/definition"
	"github.com/TongTong313/merakcode/merak/engine/agent/loop"
	"github.com/TongTong313/merakcode/merak/engine/agent/mcp"
	"github.com/TongTong313/merakcode/merak/engine/agent/model"
	"github.com/TongTong313/merakcode/merak/engine/agent/prompt"
	"github.com/TongTong313/merakcode/merak/engine/agent/session"
	"github.com/TongTong313/merakcode/merak/engine/agent/tool"
	"github.com/TongTong313/merakcode/merak/engine/collab/group"
	"github.com/TongTong313/merakcode/merak/engine/collab/kit"
	"github.com/TongTong313/merakcode/merak/engine/collab/leader"
	"github.com/TongTong313/merakcode/merak/engine/collab/task"
	"github.com/TongTong313/merakcode/merak/engine/collab/worker"
	"github.com/TongTong313/merakcode/merak/engine/infra/event"
	"github.com/TongTong313/merakcode/merak/engine/infra/store"
)

type leaderRuntime interface {
	Send(context.Context, loop.Input) error
	Close()
}

type builtinLeader struct {
	owner        *Coordinator
	conversation *conversation.Conversation
	reset        func()
}

func (r *builtinLeader) Send(ctx context.Context, input loop.Input) error {
	r.reset()
	id := r.conversation.State.Read().ID
	turn, cancel := context.WithCancel(ctx)
	r.owner.mu.Lock()
	r.owner.leaderStops[id] = cancel
	r.owner.mu.Unlock()
	outcome, err := r.owner.conversation.RunInput(turn, r.conversation, input)
	r.owner.mu.Lock()
	delete(r.owner.leaderStops, id)
	r.owner.mu.Unlock()
	cancel()
	// A person who stopped the turn ended it on purpose: the input is not sent again.
	if err != nil && ctx.Err() == nil && errors.Is(err, context.Canceled) {
		return nil
	}
	if err == nil && loop.BudgetStop(outcome.Stop) {
		return worker.BudgetExceeded{Limit: outcome.Stop}
	}
	return err
}
func (r *builtinLeader) Close() {
	r.owner.execution.ReleaseSandbox(r.conversation.State.Read().ID)
	r.conversation.Runner.Env.Jobs.Close()
	if r.conversation.Children != nil {
		r.conversation.Children.Close()
	}
}

type externalLeader struct {
	scheduler  *leader.Scheduler
	digest     leader.Digest
	owner      *Coordinator
	profile    definition.Agent
	assignment worker.Assignment
	endpoint   *mcp.Endpoint
	run        worker.Run
	initial    string
	fail       context.CancelCauseFunc
	done       chan struct{}
}

func (domain *Coordinator) externalLeaderRuntime(ctx context.Context, g *groupRun, thread *leader.Thread, p definition.Agent, fail context.CancelCauseFunc) (leaderRuntime, error) {
	caps := domain.runnerFor(p, nil).Caps()
	if !caps.MCP || !caps.Steer {
		return nil, errors.New("external leaders require MCP and steering")
	}
	saved, err := domain.manager.Load(ctx, thread.Session.Read().ID)
	if err != nil && !errors.Is(err, store.ErrNotFound) {
		return nil, err
	}
	if err == nil {
		thread.Session = saved
	}
	a := worker.Assignment{Leader: true, ReadOnly: true, Mode: p.Mode, Session: thread.Session.Read().ID, Scope: thread.Session.Read().Scope, Workdir: g.configuration().Project.Directory, Claim: task.Claim{Member: thread.Leader}}
	a.LeaderTurn = worker.NewLeaderTurn()
	server := domain.leaderMCPServer(g, thread, a.LeaderTurn.Finish)
	for name, operation := range server.Tools.Tools {
		server.Tools.Tools[name] = leaderTurnTool{Tool: operation, turn: a.LeaderTurn}
	}
	endpoint, err := mcp.Listen(ctx, server, "leader", string(thread.Key))
	if err != nil {
		return nil, err
	}
	a.MCP, err = domain.execution.MCPConfiguration(endpoint, "leader", string(thread.Key))
	if err != nil {
		endpoint.Close()
		return nil, err
	}
	for _, spec := range server.Tools.Specs() {
		a.MCP.Tools = append(a.MCP.Tools, spec.Name)
	}
	a.SandboxProfile.Network.LocalPorts = append(a.SandboxProfile.Network.LocalPorts, endpoint.Port)
	initial := ""
	if saved == nil || len(saved.Read().Messages) == 0 {
		initial = (prompt.Composer{}).System(prompt.Situation{Role: "leader", System: p.System, Environment: prompt.Environment{OS: runtime.GOOS, Workdir: a.Workdir}})
	}
	body, _ := json.Marshal(leader.Handover{Key: thread.Key, Leader: thread.Leader, Session: a.Session})
	if _, err := domain.core.Bus.Publish(ctx, event.Event{Stream: event.Stream("group:" + g.group.ID), Scope: a.Scope, Type: leader.ThreadStarted, Actor: event.Actor{Kind: event.ActorAgent, ID: thread.Leader}, Payload: body}); err != nil {
		endpoint.Close()
		return nil, err
	}
	return &externalLeader{owner: domain, profile: p, assignment: a, endpoint: endpoint, initial: initial, fail: fail, scheduler: thread.Scheduler, digest: leader.Digest{State: g.state, Focus: thread.Session.Read().Scope.Task}}, nil
}

type leaderTurnTool struct {
	tool.Tool
	turn *worker.LeaderTurn
}

func (t leaderTurnTool) Run(ctx context.Context, call tool.Call) (tool.Result, error) {
	release, err := t.turn.Enter(ctx)
	if err != nil {
		return tool.Result{}, err
	}
	defer release()
	return t.Tool.Run(ctx, call)
}

func (r *externalLeader) Send(ctx context.Context, input loop.Input) error {
	facts, stop := r.owner.core.Bus.Subscribe(event.Filter{Scope: event.Scope{Session: r.assignment.Session}, Types: []event.Type{session.MessageSent, loop.TurnFinished}})
	defer stop()
	ticker := time.NewTicker(20 * time.Millisecond)
	defer ticker.Stop()
	recorded, awaiting := false, true
	cause := input.Cause
	var steering []event.Event
	var completed event.Event
	restore := func() {
		for _, fact := range steering {
			r.scheduler.Enqueue(fact)
		}
		steering = nil
	}
	abort := func(reason error) error {
		r.fail(reason)
		ending, cancel := context.WithTimeout(context.WithoutCancel(ctx), 5*time.Second)
		defer cancel()
		if r.run != nil {
			_ = r.run.Cancel(ending)
			<-r.done
		}
		// Persistence may complete before Publish delivers the corresponding event.
		// Stop the writer before deciding whether the scheduler must retry an input.
		var persisted []event.Event
		for {
			reading, stopRead := context.WithTimeout(r.owner.core.Ctx, 5*time.Second)
			var err error
			persisted, err = r.owner.core.Store.Read(reading, event.Stream("session:"+r.assignment.Session), 1, 0)
			stopRead()
			if err == nil {
				break
			}
			// Retain the in-flight batch until durable delivery can be checked.
			select {
			case <-r.owner.core.Ctx.Done():
				return errors.Join(reason, err)
			case <-time.After(250 * time.Millisecond):
			}
		}
		for _, fact := range persisted {
			if fact.Type != session.MessageSent {
				continue
			}
			if fact.Cause == input.Cause {
				recorded = true
			}
			if awaiting && fact.Cause == cause {
				steering = nil
			}
		}
		restore()
		if recorded {
			return nil
		}
		return reason
	}
	if err := r.sendInput(ctx, input); err != nil {
		return abort(err)
	}
	accept := func(fact event.Event) {
		if fact.Type != session.MessageSent || !awaiting || fact.Cause != cause {
			return
		}
		if steering == nil {
			recorded = true
		}
		steering = nil
		awaiting = false
		if completed.Scope.Turn != fact.Scope.Turn {
			completed = event.Event{}
		}
	}
	for {
		if recorded && !awaiting && completed.ID != "" {
			outcome, _ := event.Decode[loop.Outcome](completed)
			if outcome.Stop != loop.Answered {
				r.fail(errors.New("external leader turn failed"))
				return nil
			}
			pending := false
			if r.profile.Product.Kind == definition.KindClaudeCode {
				inputs, err := worker.PendingInputs(ctx, r.owner.core.Store, r.assignment.Session)
				if err != nil {
					r.fail(err)
					return nil
				}
				pending = len(inputs) > 0
			}
			if !pending {
				return nil
			}
			completed = event.Event{}
		}
		select {
		case fact, ok := <-facts:
			if !ok {
				return abort(io.ErrUnexpectedEOF)
			}
			accept(fact)
			if fact.Type == loop.TurnFinished {
				completed = fact
			}
		case <-ticker.C:
			if !recorded || awaiting || !r.assignment.LeaderTurn.AcceptsInput() {
				continue
			}
			steering = r.scheduler.PollEvents()
			if len(steering) == 0 {
				steering = nil
				continue
			}
			steer := r.digest.Render(steering)
			cause, awaiting = steer.Cause, true
			if err := r.run.Send(ctx, steer); err != nil {
				return abort(err)
			}
		case <-ctx.Done():
			return abort(context.Cause(ctx))
		}
	}
}

func (r *externalLeader) sendInput(ctx context.Context, input loop.Input) error {
	if r.run != nil {
		return r.run.Send(ctx, input)
	}
	var text strings.Builder
	if r.initial != "" {
		text.WriteString(r.initial)
		text.WriteString("\n\n")
	}
	for _, part := range input.Parts {
		text.WriteString(part.Text)
		text.WriteByte('\n')
	}
	r.assignment.Packet, r.assignment.Cause = text.String(), input.Cause
	r.assignment.Sources = input.Sources
	run, err := r.owner.execution.StartWorker(ctx, r.profile, r.assignment)
	if err == nil {
		r.run = run
		r.done = make(chan struct{})
		go func() {
			defer close(r.done)
			_, err := run.Wait(context.Background())
			if ctx.Err() == nil {
				if err == nil {
					err = io.ErrUnexpectedEOF
				}
				r.fail(err)
			}
		}()
	}
	if err != nil {
		return err
	}
	return nil
}

func (r *externalLeader) Close() {
	if r.run != nil {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_ = r.run.Cancel(ctx)
		<-r.done
	}
	_ = r.endpoint.Close()
}

// inviteIdleWorkers offers each open task nobody holds to every idle built-in Worker of the group, once per task
// and Worker. The offer is an event, so a restart does not repeat it.
func (domain *Coordinator) inviteIdleWorkers(g *groupRun) {
	domain.inviteMu.Lock()
	defer domain.inviteMu.Unlock()
	ctx := domain.core.Ctx
	cards, err := domain.tasks.List(ctx, g.group.ID)
	if err != nil {
		return
	}
	open := task.Claimable(cards)
	busy := make(map[event.ID]bool)
	for _, card := range cards {
		for _, claim := range card.Claims {
			if claim.Status == task.ClaimActive || claim.Status == task.ClaimQueued {
				busy[claim.Member] = true
			}
		}
	}
	if len(open) == 0 {
		return
	}
	state, err := domain.groups.Get(ctx, g.group.ID)
	if err != nil {
		return
	}
	facts, err := domain.core.Store.Find(ctx, store.Query{Scope: event.Scope{Group: g.group.ID}, Types: []event.Type{task.Offered}})
	if err != nil {
		return
	}
	offered := make(map[task.Offer]bool)
	for _, fact := range facts {
		if offer, err := event.Decode[task.Offer](fact); err == nil {
			offered[offer] = true
		}
	}
	for _, member := range state.Members {
		if member.Kind != group.MemberAgent || member.AgentRole != group.AgentWorker || member.Remote || busy[member.ID] {
			continue
		}
		domain.inviteMu.Unlock()
		p, available := func() (definition.Agent, bool) {
			defer domain.inviteMu.Lock()
			if domain.memberRunning(g.group.ID, member.ID) {
				return definition.Agent{}, false
			}
			p, err := domain.roster.MemberAgent(ctx, member)
			return p, err == nil && (p.Product == nil || p.Product.Kind == definition.KindBuiltin)
		}()
		if !available {
			continue
		}
		// Another invitation may finish while member state is read without the lock.
		latest, err := domain.core.Store.Find(ctx, store.Query{Scope: event.Scope{Group: g.group.ID}, Types: []event.Type{task.Offered}})
		if err != nil {
			return
		}
		for _, fact := range latest {
			if offer, err := event.Decode[task.Offer](fact); err == nil {
				offered[offer] = true
			}
		}
		var fresh []task.Card
		for _, card := range open {
			offer := task.Offer{Task: card.ID, Member: member.ID}
			if offered[offer] {
				continue
			}
			body, _ := json.Marshal(offer)
			if _, err := domain.core.Bus.Publish(ctx, event.Event{Stream: event.Stream("group:" + g.group.ID), Scope: event.Scope{Group: g.group.ID, Task: card.ID}, Type: task.Offered, Actor: event.Actor{Kind: "system"}, Payload: body}); err != nil {
				continue
			}
			offered[offer] = true
			fresh = append(fresh, card)
		}
		if len(fresh) > 0 {
			domain.core.Workers.Go(func() { domain.runInvitation(ctx, g, member, p, fresh) })
		}
	}
}

// memberRunning reports whether a member currently holds the execution slot of its group.
func (domain *Coordinator) memberRunning(groupID, member event.ID) bool {
	source, id := domain.remote.ExecutionSource(event.Scope{Group: groupID}, member)
	return domain.execution.MemberBusy(source, id)
}

// runInvitation is one short turn of an idle Worker: it sees the unclaimed tasks, may read the project and may
// claim one with claim_task.
func (domain *Coordinator) runInvitation(ctx context.Context, g *groupRun, member group.Member, p definition.Agent, cards []task.Card) {
	scope := event.Scope{Group: g.group.ID}
	release, err := domain.execution.AcquireMember(ctx, scope, member.ID)
	if err != nil {
		return
	}
	defer release()
	chosen, err := domain.registry.MemberModel(p.Model)
	if err != nil {
		return
	}
	id := domain.core.NewID()
	scope.Session = id
	c, err := domain.conversation.NewConversation(ctx, conversation.SessionOptions{ID: id, Scope: scope, Member: member.ID, Mode: p.Mode, Provider: chosen.Provider, Model: chosen.Model, Thinking: chosen.Thinking, Workdir: g.configuration().Project.Directory, System: p.System, ToolPool: "worker.readonly", Budget: p.Budget})
	if err != nil {
		return
	}
	defer domain.execution.ReleaseSandbox(c.State.Read().ID)
	defer c.Runner.Env.Jobs.Close()
	if c.Children != nil {
		defer c.Children.Close()
	}
	c.Runner.Tools = c.Runner.Tools.With(kit.ClaimTask{Claim: func(ctx context.Context, taskID event.ID, scope []string) (task.Claim, error) {
		return domain.tasks.Claim(ctx, taskID, g.group.ID, member.ID, scope)
	}})
	c.State.SetTools(c.Runner.Tools.Specs(), "")
	if c.State, err = domain.manager.Create(ctx, *c.State); err != nil {
		return
	}
	lines := make([]string, 0, len(cards))
	for _, card := range cards {
		lines = append(lines, "- "+string(card.ID)+": "+card.Title)
	}
	text := "Unclaimed work in your group:\n" + strings.Join(lines, "\n") + "\nIf one of these fits you, take it with claim_task; you may read the project first. Otherwise reply with a single word."
	_, _ = domain.conversation.RunInput(ctx, c, loop.Input{Parts: []model.Part{{Text: text}}, Actor: event.Actor{Kind: "system"}})
}

func (domain *Coordinator) StopLeaderTurn(id event.ID) bool {
	domain.mu.Lock()
	defer domain.mu.Unlock()
	if stop := domain.leaderStops[id]; stop != nil {
		stop()
		return true
	}
	return false
}
