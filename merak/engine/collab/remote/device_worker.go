package remote

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"sync"
	"time"

	"github.com/TongTong313/merakcode/merak/engine/agent/loop"
	"github.com/TongTong313/merakcode/merak/engine/agent/permission"
	"github.com/TongTong313/merakcode/merak/engine/collab/approval"
	"github.com/TongTong313/merakcode/merak/engine/collab/group"
	"github.com/TongTong313/merakcode/merak/engine/collab/task"
	"github.com/TongTong313/merakcode/merak/engine/collab/wire"
	"github.com/TongTong313/merakcode/merak/engine/collab/worker"
	"github.com/TongTong313/merakcode/merak/engine/collab/workspace"
	"github.com/TongTong313/merakcode/merak/engine/infra/event"
	"github.com/TongTong313/merakcode/merak/engine/infra/git"
	"github.com/TongTong313/merakcode/merak/engine/infra/store"
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
	assignment wire.DeviceAssignment
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
	Assignment wire.DeviceAssignment `json:"assignment"`
	Status     task.ClaimStatus      `json:"status"`
	Account    string                `json:"host"`
}

func (domain *Remote) startDeviceAssignment(a wire.DeviceAssignment) {
	domain.cloudMu.Lock()
	host := domain.cloudHost
	domain.cloudMu.Unlock()
	domain.startHostedAssignment(host, a)
}

func (domain *Remote) startHostedAssignment(host *deviceHost, a wire.DeviceAssignment) {
	if host != nil {
		domain.startDeviceExecution(host, a, host.context, host.jobs)
	}
}

func (domain *Remote) startDeviceExecution(host *deviceHost, a wire.DeviceAssignment, work context.Context, jobs *sync.WaitGroup) {
	domain.mu.Lock()
	defer domain.mu.Unlock()
	if domain.core.Ctx.Err() != nil {
		return
	}
	domain.cloudMu.Lock()
	if work.Err() != nil || host.context.Err() != nil || domain.deviceRuns[a.Claim.ID] != nil {
		domain.cloudMu.Unlock()
		return
	}
	a.Scope.Session = a.Session
	ctx, cancel := context.WithCancel(work)
	live := &deviceRun{host: host, assignment: a, context: ctx, cancel: cancel, ready: make(chan struct{}), done: make(chan struct{}), inputReady: make(chan struct{}, 1)}
	domain.deviceRuns[a.Claim.ID] = live
	jobs.Add(1)
	domain.cloudMu.Unlock()
	domain.core.Workers.Go(func() {
		defer jobs.Done()
		defer cancel()
		defer close(live.done)
		defer func() {
			domain.cloudMu.Lock()
			if domain.deviceRuns[a.Claim.ID] == live {
				delete(domain.deviceRuns, a.Claim.ID)
			}
			select {
			case <-live.ready:
			default:
				close(live.ready)
			}
			domain.cloudMu.Unlock()
		}()
		if err := domain.runDeviceAssignment(live); err != nil && domain.core.Logger != nil {
			domain.core.Logger.Warn("Device assignment failed", "code", "MRK-1007")
		}
	})
}

func (domain *Remote) runDeviceAssignment(live *deviceRun) error {
	a, ctx := live.assignment, live.context
	prepared, stopPreparation := context.WithTimeout(context.WithoutCancel(ctx), 5*time.Second)
	defer stopPreparation()
	if a.Scope.Group == "" || a.Scope.Task == "" || a.Claim.ID == "" || a.Session == "" || a.Claim.Session != a.Session || a.Claim.Task != a.Scope.Task || a.Member == "" {
		return errors.New("invalid device assignment")
	}
	if domain.deviceHostForGroup(a.Scope.Group) != live.host {
		return errors.New("unknown cloud group")
	}
	source, err := domain.groups.Get(prepared, a.SourceGroup)
	if err != nil {
		return err
	}
	if source.Group.Kind != group.KindLocal {
		return errors.New("assignment source is not local")
	}
	member, err := domain.roster.GroupMember(prepared, a.SourceGroup, a.Member)
	if err != nil {
		return err
	}
	if member.Kind != group.MemberAgent || member.Remote {
		return errors.New("assignment requires a local agent")
	}
	p, err := domain.roster.MemberAgent(prepared, member)
	if err != nil {
		return err
	}
	card, err := domain.tasks.Get(prepared, a.Claim.Task)
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
	starts, err := domain.core.Store.Find(prepared, store.Query{Scope: event.Scope{Group: a.Scope.Group, Task: a.Scope.Task}, Types: []event.Type{task.Started}})
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
	doc, err := domain.core.Store.Fetch(prepared, "device-run", string(a.Claim.ID))
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
	err = domain.core.Store.Put(prepared, doc)
	if err != nil {
		return err
	}
	doc.Rev++
	for _, stream := range []event.Stream{event.Stream("session:" + a.Session), domain.DeviceStream(event.Event{Stream: event.Stream("group:" + a.Scope.Group), Scope: a.Scope})} {
		if err = domain.ownDeviceStream(prepared, stream, account); err != nil {
			return err
		}
	}
	var report task.Report
	var runErr error
	defer func() {
		domain.cloudPublishMu.Lock()
		defer domain.cloudPublishMu.Unlock()
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
		if _, err := domain.core.Bus.Publish(ending, event.Event{Stream: event.Stream("session:" + a.Session), Scope: a.Scope, Actor: event.Actor{Kind: event.ActorAgent, ID: a.Claim.Member}, Type: kind, Cause: a.Cause, Payload: body}); err == nil {
			doc.Body, _ = json.Marshal(deviceRecord{Assignment: a, Status: status, Account: account})
			_ = domain.core.Store.Put(ending, doc)
		}
		domain.cloudMu.Lock()
		if domain.deviceRuns[a.Claim.ID] == live {
			delete(domain.deviceRuns, a.Claim.ID)
		}
		domain.cloudMu.Unlock()
		select {
		case domain.cloudWake <- struct{}{}:
		default:
		}
	}()
	project := source.Group.Project.Directory
	if card.Workspace == workspace.KindWorktree || strings.HasPrefix(live.host.id, "remote:") && card.Workspace != workspace.KindNone {
		host, err := domain.groups.Get(ctx, card.Group)
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
	ws, err := domain.workspaces.ForClaim(ctx, project, a.Claim, card)
	if err != nil {
		runErr = err
		return err
	}
	a.Claim.Workspace = ws.ID
	domain.cloudMu.Lock()
	live.project = project
	live.assignment.Claim.Workspace = ws.ID
	domain.cloudMu.Unlock()
	defer func() {
		ending, stop := context.WithTimeout(context.WithoutCancel(ctx), 5*time.Second)
		defer stop()
		_ = domain.workspaces.EndClaim(ending, ws)
	}()
	assignment := worker.Assignment{Cause: a.Cause, Claim: a.Claim, Session: a.Session, Scope: a.Scope, Packet: a.Packet, Workdir: ws.Directory, ReadOnly: card.Workspace == workspace.KindNone}
	assignment.Claim.Workspace = ws.ID
	if err = domain.execution.SetupWorkspace(ctx, p, assignment, ws, source.Group.Settings.Setup); err != nil {
		runErr = err
		return err
	}
	run, err := domain.execution.StartWorker(ctx, p, assignment)
	domain.cloudMu.Lock()
	live.run = run
	close(live.ready)
	domain.cloudMu.Unlock()
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

func (domain *Remote) cancelDeviceClaim(ctx context.Context, id event.ID) {
	domain.cloudMu.Lock()
	run := domain.deviceRuns[id]
	domain.cloudMu.Unlock()
	if run != nil {
		run.cancel()
	}
}
func (domain *Remote) sendDeviceMessage(ctx context.Context, message wire.DeviceMessage) {
	domain.cloudMu.Lock()
	run := domain.deviceRuns[message.Claim]
	domain.cloudMu.Unlock()
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

func (domain *Remote) RouteDevicePermission(ctx context.Context, req permission.Request) (permission.Reply, bool, error) {
	scope := req.Call.Env.Scope
	if _, ok := domain.roster.HostedGroup(scope.Group); !ok {
		return permission.Reply{}, false, nil
	}
	host := domain.deviceHostForGroup(scope.Group)
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
	state, err := domain.groups.Get(ctx, scope.Group)
	if err != nil {
		return permission.Reply{}, true, err
	}
	req.RequiredRole = approval.Need(req, workspace.Workspace{Directory: req.Call.Env.Workdir}, state.Group)
	if req.Mode == permission.ModeAuto && req.Kind == "" && req.RequiredRole == group.RoleApprover && scope.Task != "" {
		for _, member := range state.Members {
			if member.ID != req.Member || member.Kind != group.MemberAgent || member.AgentRole != group.AgentWorker {
				continue
			}
			card, err := domain.tasks.Get(ctx, scope.Task)
			if err != nil {
				return permission.Reply{}, true, err
			}
			for card.Parent != "" {
				card, err = domain.tasks.Get(ctx, card.Parent)
				if err != nil {
					return permission.Reply{}, true, err
				}
			}
			if state, err := domain.groups.Get(ctx, card.Group); err == nil {
				req.Leader = state.Group.Leader
			}
		}
	}
	replies := make(chan permission.Reply, 1)
	domain.cloudReplyMu.Lock()
	body, _ := json.Marshal(req)
	fact, err := domain.core.Bus.Publish(ctx, event.Event{Stream: stream, Scope: scope, Actor: event.Actor{Kind: event.ActorAgent, ID: req.Call.Env.Member}, Type: permission.Requested, Payload: body})
	if err == nil {
		domain.cloudReplies[fact.ID] = replies
	}
	domain.cloudReplyMu.Unlock()
	if err != nil {
		return permission.Reply{}, true, err
	}
	defer func() {
		domain.cloudReplyMu.Lock()
		delete(domain.cloudReplies, fact.ID)
		domain.cloudReplyMu.Unlock()
	}()
	select {
	case domain.cloudWake <- struct{}{}:
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
		_, err = domain.core.Bus.Publish(ctx, event.Event{Stream: stream, Scope: scope, Actor: actor, Type: permission.Replied, Cause: fact.ID, Payload: body})
		return reply, true, err
	}
}
func (domain *Remote) answerDevicePermission(reply wire.DeviceReply) {
	if reply.Decision != permission.Allow && reply.Decision != permission.Deny {
		return
	}
	fact, err := domain.core.Store.Get(domain.core.Ctx, reply.Request)
	if err != nil || fact.Type != permission.Requested || !domain.ActiveDeviceGroup(fact.Scope.Group) {
		return
	}
	domain.cloudReplyMu.Lock()
	defer domain.cloudReplyMu.Unlock()
	if pending := domain.cloudReplies[reply.Request]; pending != nil {
		select {
		case pending <- permission.Reply{Leader: reply.Leader, Human: reply.Human, Decision: reply.Decision, Remember: reply.Remember}:
		default:
		}
	}
}
