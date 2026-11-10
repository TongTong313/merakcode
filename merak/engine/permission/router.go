package permission

import (
	"context"
	"encoding/json"
	"errors"
	"sync"
	"time"

	"github.com/TongTong313/merakcode/merak/engine/event"
	"github.com/TongTong313/merakcode/merak/engine/group"
	"github.com/TongTong313/merakcode/merak/engine/task"
	"github.com/TongTong313/merakcode/merak/engine/workspace"
)

const (
	Routed    event.Type = "permission.routed"
	Escalated event.Type = "permission.escalated"
)

var errApprovalTimeout = errors.New("approval timed out")

func init() {
	event.Register[Request](Routed)
	event.Register[Request](Escalated)
}

type Router struct {
	Remote   func(context.Context, Request) (Reply, bool, error)
	TimedOut func(context.Context, event.Scope, event.ID, event.ID)
	Timeout  time.Duration
	Bus      *event.Bus
	Groups   *group.Manager
	Tasks    *task.Pool
	Human    func(context.Context, Request) (Reply, error)
	mu       sync.Mutex
	pending  map[event.ID]*pendingApproval
}

type pendingApproval struct {
	context  context.Context
	request  Request
	root     event.ID
	leader   event.ID
	role     group.Role
	reply    chan Reply
	escalate chan struct{}
	human    bool
	answered bool
}

func (r *Router) Ask(ctx context.Context, req Request) (reply Reply, err error) {
	if r.Remote != nil {
		if reply, handled, err := r.Remote(ctx, req); handled {
			return reply, err
		}
	}
	return r.ask(ctx, req, "", time.Now())
}

// AskRemote uses the execution device's path classification and original request time.
func (r *Router) AskRemote(ctx context.Context, req Request, started time.Time) (Reply, error) {
	switch req.RequiredRole {
	case group.RoleApprover, group.RoleAdmin, group.RoleOwner:
	default:
		return Reply{}, errors.New("remote approval role is required")
	}
	return r.ask(ctx, req, req.RequiredRole, started)
}

func (r *Router) ask(ctx context.Context, req Request, required group.Role, started time.Time) (reply Reply, err error) {
	timeout := r.Timeout
	if req.Call.Env.Scope.Group != "" {
		state, err := r.Groups.Get(ctx, req.Call.Env.Scope.Group)
		if err != nil {
			return Reply{}, err
		}
		timeout = state.Group.Settings.ApprovalWait(timeout)
	}
	if timeout <= 0 {
		timeout = 30 * time.Minute
	}
	var cancel context.CancelFunc
	if req.Kind == "workspace" {
		req.Call.Env.Scope.Task, req.Call.Env.Scope.Turn = "", ""
		ctx, cancel = context.WithCancel(ctx)
	} else {
		ctx, cancel = context.WithDeadlineCause(ctx, started.Add(timeout), errApprovalTimeout)
	}
	defer cancel()
	req.Leader = ""
	pending := &pendingApproval{context: ctx, request: req, reply: make(chan Reply, 1), escalate: make(chan struct{}, 1), human: true}
	var participants []event.ID
	if req.Call.Env.Scope.Group != "" {
		state, err := r.Groups.Get(ctx, req.Call.Env.Scope.Group)
		if err != nil {
			return Reply{}, err
		}
		pending.role = Need(req, workspace.Workspace{Directory: req.Call.Env.Workdir}, state.Group)
		if required != "" {
			pending.role = required
		}
		if req.Call.Env.Scope.Task != "" {
			card, err := r.Tasks.Get(ctx, req.Call.Env.Scope.Task)
			if err != nil || card.Group != state.Group.ID {
				return Reply{}, errors.New("approval task is outside the group")
			}
			participants = card.Participants
			for card.Parent != "" {
				card, err = r.Tasks.Get(ctx, card.Parent)
				if err != nil {
					return Reply{}, err
				}
			}
			pending.root, pending.leader = card.ID, card.Leader
		}
		if req.Mode == ModeAuto && req.Kind == "" && pending.role == group.RoleApprover && pending.leader != "" {
			for _, member := range state.Members {
				if member.ID == req.Member && member.Kind == group.MemberAgent && member.AgentRole == group.AgentWorker {
					req.Leader, pending.human = pending.leader, false
				}
			}
		}
	}
	r.mu.Lock()
	if r.pending == nil {
		r.pending = make(map[event.ID]*pendingApproval)
	}
	if req.ID == "" {
		fact, err := r.publish(ctx, event.Stream("session:"+req.Call.Env.Scope.Session), req, Requested, "")
		if err != nil {
			r.mu.Unlock()
			return Reply{}, err
		}
		req.ID = fact.ID
	}
	pending.request = req
	r.pending[req.ID] = pending
	delegated := !pending.human
	r.mu.Unlock()
	defer func() { r.mu.Lock(); delete(r.pending, req.ID); r.mu.Unlock() }()
	defer func() {
		if errors.Is(context.Cause(ctx), errApprovalTimeout) {
			r.timedOut(context.WithoutCancel(ctx), pending)
		}
	}()
	defer func() {
		if req.Kind == "workspace" && ctx.Err() != nil && err != nil {
			return
		}
		if err != nil {
			reply = Reply{Decision: Deny}
		}
		body, _ := json.Marshal(reply)
		actor := event.Actor{Kind: event.ActorHuman, ID: reply.Human}
		if reply.Leader != "" {
			actor = event.Actor{Kind: event.ActorAgent, ID: reply.Leader}
		}
		var streams []event.Stream
		if req.Call.Env.Scope.Session != "" {
			streams = append(streams, event.Stream("session:"+req.Call.Env.Scope.Session))
		}
		if req.Call.Env.Scope.Group != "" {
			streams = append(streams, event.Stream("group:"+req.Call.Env.Scope.Group))
		}
		for _, stream := range streams {
			_, publishErr := r.Bus.Publish(context.WithoutCancel(ctx), event.Event{Stream: stream, Scope: req.Call.Env.Scope, Type: Replied, Cause: req.ID, Actor: actor, Payload: body})
			if err == nil {
				err = publishErr
			}
		}
	}()
	defer func() {
		if err == nil {
			cancel()
		}
	}()
	if delegated {
		if _, err := r.publish(ctx, event.Stream("group:"+req.Call.Env.Scope.Group), req, Routed, req.ID); err != nil {
			return Reply{}, err
		}
		select {
		case reply := <-pending.reply:
			return reply, nil
		case <-pending.escalate:
			req.Leader = ""
			if _, err := r.publish(ctx, event.Stream("session:"+req.Call.Env.Scope.Session), req, Escalated, req.ID); err != nil {
				return Reply{}, err
			}
		case <-ctx.Done():
			return Reply{}, ctx.Err()
		}
	}
	return r.askHuman(ctx, pending, participants)
}

func (r *Router) askHuman(ctx context.Context, pending *pendingApproval, participants []event.ID) (Reply, error) {
	req := pending.request
	req.Leader = ""
	if req.Call.Env.Scope.Group != "" {
		state, err := r.Groups.Get(ctx, req.Call.Env.Scope.Group)
		if err != nil {
			return Reply{}, err
		}
		body, _ := json.Marshal(group.Notice{Kind: "permission", To: Recipients(state.Members, pending.role, participants), Text: req.Spec.Name})
		if _, err := r.Bus.Publish(ctx, event.Event{Stream: event.Stream("group:" + state.Group.ID), Scope: req.Call.Env.Scope, Type: group.NoticeSent, Cause: req.ID, Actor: event.Actor{Kind: event.ActorAgent, ID: req.Member}, Payload: body}); err != nil {
			return Reply{}, err
		}
	}
	if r.Human == nil {
		if req.Call.Env.Scope.Group != "" || req.Kind == "workspace" {
			<-ctx.Done()
			return Reply{}, ctx.Err()
		}
		return Reply{Decision: Deny}, nil
	}
	reply, err := r.Human(ctx, req)
	if err != nil {
		return Reply{}, err
	}
	if err := ctx.Err(); err != nil {
		return Reply{}, err
	}
	if req.Call.Env.Scope.Group != "" {
		human, err := r.AuthorizeHuman(ctx, req.ID, reply.Human)
		if err != nil {
			return Reply{Decision: Deny}, nil
		}
		reply.Human = human
	}
	reply.Leader = ""
	return reply, nil
}

// PendingHumans returns requests that a newly connected approval client may offer.
func (r *Router) PendingHumans() []event.ID {
	r.mu.Lock()
	defer r.mu.Unlock()
	var ids []event.ID
	for id, pending := range r.pending {
		if pending.human && !pending.answered {
			ids = append(ids, id)
		}
	}
	return ids
}

func (r *Router) timedOut(ctx context.Context, pending *pendingApproval) {
	scope := pending.request.Call.Env.Scope
	if scope.Group == "" {
		return
	}
	if r.TimedOut != nil {
		r.TimedOut(ctx, scope, pending.request.Member, pending.request.ID)
		return
	}
	if scope.Task != "" {
		_ = r.Tasks.Block(ctx, scope.Task)
	}
	state, err := r.Groups.Get(ctx, scope.Group)
	if err != nil {
		return
	}
	var owners []event.ID
	for _, member := range state.Members {
		if member.Can(group.RoleOwner) {
			owners = append(owners, member.ID)
		}
	}
	body, _ := json.Marshal(group.Notice{Kind: "blocked", To: owners, Text: "Permission request timed out."})
	_, _ = r.Bus.Publish(ctx, event.Event{Stream: event.Stream("group:" + scope.Group), Scope: scope, Type: group.NoticeSent, Cause: pending.request.ID, Actor: event.Actor{Kind: event.ActorAgent}, Payload: body})
}

func (r *Router) AuthorizeHuman(ctx context.Context, id, human event.ID) (event.ID, error) {
	r.mu.Lock()
	pending := r.pending[id]
	if pending == nil || !pending.human {
		r.mu.Unlock()
		return "", errors.New("approval is not waiting for a human")
	}
	req, role := pending.request, pending.role
	r.mu.Unlock()
	if req.Call.Env.Scope.Group == "" {
		return human, nil
	}
	state, err := r.Groups.Get(ctx, req.Call.Env.Scope.Group)
	if err != nil {
		return "", err
	}
	if human == "" {
		var humans []event.ID
		for _, member := range state.Members {
			if member.Kind == group.MemberHuman {
				humans = append(humans, member.ID)
			}
		}
		if len(humans) == 1 {
			human = humans[0]
		}
	}
	for _, member := range state.Members {
		if member.ID == human && member.Can(role) {
			return human, nil
		}
	}
	return "", errors.New("human does not have the required approval role")
}

func (r *Router) Approve(ctx context.Context, id, groupID, root, leader event.ID, decision Decision) error {
	if decision != Allow && decision != Deny {
		return errors.New("approval requires allow or deny")
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	pending, err := r.leaderRequest(ctx, id, groupID, root, leader)
	if err != nil {
		return err
	}
	if pending.role != group.RoleApprover || pending.request.Leader == "" {
		r.escalate(pending)
		return errors.New("this approval requires a human")
	}
	if pending.human || pending.answered {
		return errors.New("approval is no longer waiting for this Leader")
	}
	pending.answered = true
	pending.reply <- Reply{Decision: decision, Leader: leader}
	return nil
}

func (r *Router) Escalate(ctx context.Context, id, groupID, root, leader event.ID) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	pending, err := r.leaderRequest(ctx, id, groupID, root, leader)
	if err != nil {
		return err
	}
	if pending.answered {
		return errors.New("approval is already answered")
	}
	r.escalate(pending)
	return nil
}

func (r *Router) leaderRequest(ctx context.Context, id, groupID, root, leader event.ID) (*pendingApproval, error) {
	pending := r.pending[id]
	if pending == nil || pending.request.Call.Env.Scope.Group != groupID || pending.root != root {
		return nil, errors.New("approval is outside this task thread")
	}
	if err := pending.context.Err(); err != nil {
		return nil, err
	}
	card, err := r.Tasks.Get(ctx, root)
	if err != nil || card.Leader != leader || pending.leader != leader {
		return nil, errors.New("approval belongs to another Leader")
	}
	return pending, nil
}

// Transfer re-delivers pending requests after the task thread installs its new Leader.
func (r *Router) Transfer(ctx context.Context, groupID, root event.ID) error {
	card, err := r.Tasks.Get(ctx, root)
	if err != nil {
		return err
	}
	if card.Group != groupID || card.Parent != "" {
		return errors.New("approval thread is outside this group")
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	for _, pending := range r.pending {
		if pending.request.Call.Env.Scope.Group != groupID || pending.root != root || pending.human || pending.answered || pending.context.Err() != nil {
			continue
		}
		pending.leader, pending.request.Leader = card.Leader, card.Leader
		if _, err := r.publish(ctx, event.Stream("group:"+groupID), pending.request, Routed, pending.request.ID); err != nil {
			return err
		}
	}
	return nil
}

func (r *Router) escalate(pending *pendingApproval) {
	if pending.human {
		return
	}
	pending.human = true
	pending.escalate <- struct{}{}
}

func (r *Router) publish(ctx context.Context, stream event.Stream, req Request, kind event.Type, cause event.ID) (event.Event, error) {
	if stream == "session:" && req.Call.Env.Scope.Group != "" {
		stream = event.Stream("group:" + req.Call.Env.Scope.Group)
	}
	body, err := json.Marshal(req)
	if err != nil {
		return event.Event{}, err
	}
	return r.Bus.Publish(ctx, event.Event{Stream: stream, Scope: req.Call.Env.Scope, Type: kind, Cause: cause, Actor: event.Actor{Kind: event.ActorAgent, ID: req.Member}, Payload: body})
}
