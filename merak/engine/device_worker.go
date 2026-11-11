package engine

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"sync"
	"time"

	"github.com/TongTong313/merakcode/merak/engine/event"
	"github.com/TongTong313/merakcode/merak/engine/group"
	"github.com/TongTong313/merakcode/merak/engine/loop"
	"github.com/TongTong313/merakcode/merak/engine/permission"
	"github.com/TongTong313/merakcode/merak/engine/profile"
	"github.com/TongTong313/merakcode/merak/engine/store"
	"github.com/TongTong313/merakcode/merak/engine/task"
	"github.com/TongTong313/merakcode/merak/engine/worker"
	"github.com/TongTong313/merakcode/merak/engine/workspace"
	"github.com/TongTong313/merakcode/merak/internal/platform/git"
	"github.com/TongTong313/merakcode/merak/protocol"
)

const DeviceReported event.Type = "claim.reported"
const DeviceInterrupted event.Type = "claim.interrupted"

func init() {
	event.Register[task.Report](DeviceReported)
	event.Register[task.Claim](DeviceInterrupted)
}

type deviceRun struct {
	project    string
	host       *deviceHost
	assignment protocol.DeviceAssignment
	context    context.Context
	cancel     context.CancelFunc
	ready      chan struct{}
	done       chan struct{}
	run        worker.Run
	inputMu    sync.Mutex
	inputs     []loop.Input
	inputReady chan struct{}
}
type deviceRecord struct {
	Assignment protocol.DeviceAssignment `json:"assignment"`
	Status     task.ClaimStatus          `json:"status"`
	Account    string                    `json:"host"`
}

func (e *Engine) startDeviceAssignment(a protocol.DeviceAssignment) {
	e.cloudMu.Lock()
	host := e.cloudHost
	e.cloudMu.Unlock()
	e.startHostedAssignment(host, a)
}

func (e *Engine) startHostedAssignment(host *deviceHost, a protocol.DeviceAssignment) {
	if host != nil {
		e.startDeviceExecution(host, a, host.context, host.jobs)
	}
}

func (e *Engine) startDeviceExecution(host *deviceHost, a protocol.DeviceAssignment, work context.Context, jobs *sync.WaitGroup) {
	e.mu.Lock()
	defer e.mu.Unlock()
	if e.ctx.Err() != nil {
		return
	}
	e.cloudMu.Lock()
	if work.Err() != nil || host.context.Err() != nil || e.deviceRuns[a.Claim.ID] != nil {
		e.cloudMu.Unlock()
		return
	}
	a.Scope.Session = a.Session
	ctx, cancel := context.WithCancel(work)
	live := &deviceRun{host: host, assignment: a, context: ctx, cancel: cancel, ready: make(chan struct{}), done: make(chan struct{}), inputReady: make(chan struct{}, 1)}
	e.deviceRuns[a.Claim.ID] = live
	jobs.Add(1)
	e.cloudMu.Unlock()
	e.workers.Go(func() {
		defer jobs.Done()
		defer cancel()
		defer close(live.done)
		defer func() {
			e.cloudMu.Lock()
			if e.deviceRuns[a.Claim.ID] == live {
				delete(e.deviceRuns, a.Claim.ID)
			}
			select {
			case <-live.ready:
			default:
				close(live.ready)
			}
			e.cloudMu.Unlock()
		}()
		if err := e.runDeviceAssignment(live); err != nil && e.logger != nil {
			e.logger.Warn("Device assignment failed", "code", "MRK-1007")
		}
	})
}

func (e *Engine) runDeviceAssignment(live *deviceRun) error {
	a, ctx := live.assignment, live.context
	prepared, stopPreparation := context.WithTimeout(context.WithoutCancel(ctx), 5*time.Second)
	defer stopPreparation()
	if a.Scope.Group == "" || a.Scope.Task == "" || a.Claim.ID == "" || a.Session == "" || a.Claim.Session != a.Session || a.Claim.Task != a.Scope.Task || a.Member == "" {
		return errors.New("invalid device assignment")
	}
	if e.deviceHostForGroup(a.Scope.Group) != live.host {
		return errors.New("unknown cloud group")
	}
	source, err := e.Groups.Get(prepared, a.SourceGroup)
	if err != nil {
		return err
	}
	if source.Group.Kind != group.KindLocal {
		return errors.New("assignment source is not local")
	}
	member, err := e.groupMember(prepared, a.SourceGroup, a.Member)
	if err != nil {
		return err
	}
	if member.Kind != group.MemberAgent || member.Remote {
		return errors.New("assignment requires a local agent")
	}
	p, err := e.memberProfile(prepared, member)
	if err != nil {
		return err
	}
	if p.Role == profile.Leader {
		p.Role, p.ToolPool = profile.Worker, "worker.default"
	}
	card, err := e.Tasks.Get(prepared, a.Claim.Task)
	if err != nil {
		return err
	}
	valid := false
	for _, claim := range card.Claims {
		if claim.ID == a.Claim.ID && claim.Member == a.Claim.Member && claim.Session == a.Session && claim.Status == task.ClaimActive {
			valid = true
		}
	}
	if !valid || card.Group != a.Scope.Group {
		return errors.New("assignment does not match the host claim")
	}
	starts, err := e.store.Find(prepared, store.Query{Scope: event.Scope{Group: a.Scope.Group, Task: a.Scope.Task}, Types: []event.Type{task.Started}})
	if err != nil {
		return err
	}
	if a.Cause == "" && len(starts) > 0 {
		a.Cause = starts[len(starts)-1].ID
	}
	known := false
	for _, fact := range starts {
		if fact.ID == a.Cause {
			known = true
			break
		}
	}
	if !known {
		return errors.New("assignment requires its host start event")
	}
	doc, err := e.store.Fetch(prepared, "device-run", string(a.Claim.ID))
	if err == nil {
		var previous deviceRecord
		if err = json.Unmarshal(doc.Body, &previous); err != nil {
			return err
		}
		if previous.Assignment.Cause == a.Cause {
			return nil
		}
		if previous.Status == task.ClaimActive || previous.Assignment.Session != a.Session || previous.Assignment.SourceGroup != a.SourceGroup || previous.Assignment.Member != a.Member {
			return errors.New("device claim cannot be replaced")
		}
	}
	if err != nil && !errors.Is(err, store.ErrNotFound) {
		return err
	}
	account := live.host.id
	body, _ := json.Marshal(deviceRecord{Assignment: a, Status: task.ClaimActive, Account: account})
	doc.Kind, doc.Key, doc.Body = "device-run", string(a.Claim.ID), body
	err = e.store.Put(prepared, doc)
	if err != nil {
		return err
	}
	doc.Rev++
	for _, stream := range []event.Stream{event.Stream("session:" + a.Session), e.deviceStream(event.Event{Stream: event.Stream("group:" + a.Scope.Group), Scope: a.Scope})} {
		if err = e.ownDeviceStream(prepared, stream, account); err != nil {
			return err
		}
	}
	var report task.Report
	var runErr error
	defer func() {
		e.cloudPublishMu.Lock()
		defer e.cloudPublishMu.Unlock()
		ending, stop := context.WithTimeout(context.WithoutCancel(ctx), 5*time.Second)
		defer stop()
		status := task.ClaimReported
		if ctx.Err() != nil {
			status = task.ClaimInterrupted
		}
		if report.Claim == "" {
			report = worker.ReportFromText(a.Claim.ID, "Device member could not finish.", loop.Failed, runErr)
		}
		kind := DeviceReported
		var payload any = report
		if status == task.ClaimInterrupted {
			claim := a.Claim
			claim.Status = status
			kind, payload = DeviceInterrupted, claim
		}
		body, _ := json.Marshal(payload)
		if _, err := e.Bus.Publish(ending, event.Event{Stream: event.Stream("session:" + a.Session), Scope: a.Scope, Actor: event.Actor{Kind: event.ActorAgent, ID: a.Claim.Member}, Type: kind, Cause: a.Cause, Payload: body}); err == nil {
			doc.Body, _ = json.Marshal(deviceRecord{Assignment: a, Status: status, Account: account})
			_ = e.store.Put(ending, doc)
		}
		e.cloudMu.Lock()
		if e.deviceRuns[a.Claim.ID] == live {
			delete(e.deviceRuns, a.Claim.ID)
		}
		e.cloudMu.Unlock()
		select {
		case e.cloudWake <- struct{}{}:
		default:
		}
	}()
	project := source.Group.Project.Directory
	if card.Workspace == workspace.KindWorktree || strings.HasPrefix(live.host.id, "remote:") && card.Workspace != workspace.KindNone {
		host, err := e.Groups.Get(ctx, card.Group)
		if err != nil {
			runErr = err
			return err
		}
		project = member.Checkouts[host.Group.Project.Remote]
		if card.Workspace != workspace.KindWorktree || project == "" || host.Group.Project.Remote == "" {
			runErr = errors.New("MRK-6001: remote tasks require none or a declared repository checkout")
			return runErr
		}
		if err := git.Fetch(ctx, project, host.Group.Project.Remote); err != nil {
			runErr = err
			return err
		}
		if _, err := git.Commit(ctx, project, card.Base); err != nil {
			runErr = err
			return err
		}
		p.System += "\nWork in the assigned Git worktree. Verify and commit changes on its branch before submitting your report."
	}
	ws, err := e.Workspaces.ForClaim(ctx, project, a.Claim, card)
	if err != nil {
		runErr = err
		return err
	}
	a.Claim.Workspace = ws.ID
	e.cloudMu.Lock()
	live.project = project
	live.assignment.Claim.Workspace = ws.ID
	e.cloudMu.Unlock()
	defer func() {
		ending, stop := context.WithTimeout(context.WithoutCancel(ctx), 5*time.Second)
		defer stop()
		_ = e.Workspaces.EndClaim(ending, ws)
	}()
	assignment := worker.Assignment{Cause: a.Cause, Claim: a.Claim, Session: a.Session, Scope: a.Scope, Packet: a.Packet, Workdir: ws.Directory, ReadOnly: card.Workspace == workspace.KindNone}
	assignment.Claim.Workspace = ws.ID
	if err = e.setupWorkspace(ctx, p, assignment, ws, source.Group.Settings.Setup); err != nil {
		runErr = err
		return err
	}
	run, err := e.StartWorker(ctx, p, assignment)
	e.cloudMu.Lock()
	live.run = run
	close(live.ready)
	e.cloudMu.Unlock()
	if err != nil {
		runErr = err
		return err
	}
	inputDone := make(chan struct{})
	inputContext, stopInputs := context.WithCancel(ctx)
	go func() { defer close(inputDone); live.forwardInputs(inputContext, run) }()
	defer func() { stopInputs(); <-inputDone }()
	report, runErr = run.Wait(context.Background())
	return runErr
}

func (e *Engine) cancelDeviceClaim(ctx context.Context, id event.ID) {
	e.cloudMu.Lock()
	run := e.deviceRuns[id]
	e.cloudMu.Unlock()
	if run != nil {
		run.cancel()
	}
}
func (e *Engine) sendDeviceMessage(ctx context.Context, message protocol.DeviceMessage) {
	e.cloudMu.Lock()
	run := e.deviceRuns[message.Claim]
	e.cloudMu.Unlock()
	if run == nil {
		return
	}
	run.inputMu.Lock()
	run.inputs = append(run.inputs, message.Input)
	run.inputMu.Unlock()
	select {
	case run.inputReady <- struct{}{}:
	default:
	}
}

func (r *deviceRun) forwardInputs(ctx context.Context, run worker.Run) {
	for {
		select {
		case <-ctx.Done():
			return
		case <-r.inputReady:
		}
		r.inputMu.Lock()
		inputs := r.inputs
		r.inputs = nil
		r.inputMu.Unlock()
		for _, input := range inputs {
			if run.Send(ctx, input) != nil {
				return
			}
		}
	}
}

func (e *Engine) routeDevicePermission(ctx context.Context, req permission.Request) (permission.Reply, bool, error) {
	scope := req.Call.Env.Scope
	if _, ok := e.hostedGroups.Load(scope.Group); !ok {
		return permission.Reply{}, false, nil
	}
	host := e.deviceHostForGroup(scope.Group)
	if host == nil || host.context.Err() != nil {
		return permission.Reply{}, true, errors.New("MRK-1006")
	}
	ctx, cancel := context.WithCancel(ctx)
	defer cancel()
	stop := context.AfterFunc(host.context, cancel)
	defer stop()
	stream := event.Stream("session:" + scope.Session)
	if scope.Session == "" {
		stream = event.Stream("group:" + scope.Group)
	}
	state, err := e.Groups.Get(ctx, scope.Group)
	if err != nil {
		return permission.Reply{}, true, err
	}
	req.RequiredRole = permission.Need(req, workspace.Workspace{Directory: req.Call.Env.Workdir}, state.Group)
	if req.Mode == permission.ModeAuto && req.Kind == "" && req.RequiredRole == group.RoleApprover && scope.Task != "" {
		for _, member := range state.Members {
			if member.ID != req.Member || member.Kind != group.MemberAgent || member.AgentRole != group.AgentWorker {
				continue
			}
			card, err := e.Tasks.Get(ctx, scope.Task)
			if err != nil {
				return permission.Reply{}, true, err
			}
			for card.Parent != "" {
				card, err = e.Tasks.Get(ctx, card.Parent)
				if err != nil {
					return permission.Reply{}, true, err
				}
			}
			req.Leader = card.Leader
		}
	}
	replies := make(chan permission.Reply, 1)
	e.cloudReplyMu.Lock()
	body, _ := json.Marshal(req)
	fact, err := e.Bus.Publish(ctx, event.Event{Stream: stream, Scope: scope, Actor: event.Actor{Kind: event.ActorAgent, ID: req.Call.Env.Member}, Type: permission.Requested, Payload: body})
	if err == nil {
		e.cloudReplies[fact.ID] = replies
	}
	e.cloudReplyMu.Unlock()
	if err != nil {
		return permission.Reply{}, true, err
	}
	defer func() { e.cloudReplyMu.Lock(); delete(e.cloudReplies, fact.ID); e.cloudReplyMu.Unlock() }()
	select {
	case e.cloudWake <- struct{}{}:
	default:
	}
	select {
	case <-ctx.Done():
		return permission.Reply{}, true, ctx.Err()
	case reply := <-replies:
		body, _ = json.Marshal(reply)
		actor := event.Actor{Kind: event.ActorHuman, ID: reply.Human}
		if reply.Leader != "" {
			actor = event.Actor{Kind: event.ActorAgent, ID: reply.Leader}
		}
		_, err = e.Bus.Publish(ctx, event.Event{Stream: stream, Scope: scope, Actor: actor, Type: permission.Replied, Cause: fact.ID, Payload: body})
		return reply, true, err
	}
}
func (e *Engine) answerDevicePermission(reply protocol.DeviceReply) {
	if reply.Decision != permission.Allow && reply.Decision != permission.Deny {
		return
	}
	fact, err := e.store.Get(e.ctx, reply.Request)
	if err != nil || fact.Type != permission.Requested || !e.activeDeviceGroup(fact.Scope.Group) {
		return
	}
	e.cloudReplyMu.Lock()
	defer e.cloudReplyMu.Unlock()
	if pending := e.cloudReplies[reply.Request]; pending != nil {
		select {
		case pending <- permission.Reply{Leader: reply.Leader, Human: reply.Human, Decision: reply.Decision, Remember: reply.Remember}:
		default:
		}
	}
}
