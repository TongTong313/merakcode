package coordinator

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"slices"
	"strings"
	"sync/atomic"
	"time"

	"github.com/TongTong313/merakcode/merak/engine/agent/conversation"
	"github.com/TongTong313/merakcode/merak/engine/agent/definition"
	"github.com/TongTong313/merakcode/merak/engine/agent/loop"
	"github.com/TongTong313/merakcode/merak/engine/agent/model"
	"github.com/TongTong313/merakcode/merak/engine/agent/question"
	"github.com/TongTong313/merakcode/merak/engine/agent/registry"
	"github.com/TongTong313/merakcode/merak/engine/collab/execution"
	"github.com/TongTong313/merakcode/merak/engine/collab/group"
	"github.com/TongTong313/merakcode/merak/engine/collab/leader"
	"github.com/TongTong313/merakcode/merak/engine/collab/task"
	"github.com/TongTong313/merakcode/merak/engine/collab/worker"
	"github.com/TongTong313/merakcode/merak/engine/collab/workspace"
	"github.com/TongTong313/merakcode/merak/engine/infra/errorcode"
	"github.com/TongTong313/merakcode/merak/engine/infra/event"
	"github.com/TongTong313/merakcode/merak/engine/infra/folder"
	"github.com/TongTong313/merakcode/merak/engine/infra/git"
	"github.com/TongTong313/merakcode/merak/engine/infra/store"
)

type groupRun struct {
	latest       atomic.Pointer[group.Group]
	triggers     *leader.Triggers
	group        group.Group
	state        *leader.State
	threads      *leader.Threads
	started      map[event.ID]*leaderRun
	handovers    map[event.ID]*pendingHandover
	handoverDone chan completedHandover
	leaderDone   chan completedLeader
	seq          uint64
}

func (g *groupRun) configuration() group.Group {
	if latest := g.latest.Load(); latest != nil {
		return *latest
	}
	return g.group
}

type leaderRun struct {
	cancel context.CancelFunc
	done   chan struct{}
	again  bool
}

type completedLeader struct {
	thread *leader.Thread
	run    *leaderRun
}

func (domain *Coordinator) CreateGroup(ctx context.Context, g group.Group, members []group.Member) (group.Group, error) {
	return domain.CreateGroupForTask(ctx, g, members, "")
}

// CreateGroupForTask creates a local group for a task that no group has taken. The workspace of the group is the one
// of the task, and once the group exists it takes the task.
func (domain *Coordinator) CreateGroupForTask(ctx context.Context, g group.Group, members []group.Member, taskID event.ID) (group.Group, error) {
	if taskID == "" {
		return domain.createGroup(ctx, g, members)
	}
	if g.Kind != group.KindLocal {
		return group.Group{}, errorcode.Coded(errorcode.CloudGroupTakesNoTask, errors.New("cloud groups do not take tasks yet"))
	}
	card, err := domain.tasks.Get(ctx, taskID)
	if err != nil {
		return group.Group{}, err
	}
	if card.Group != "" {
		return group.Group{}, errorcode.Coded(errorcode.TaskAlreadyInGroup, task.ErrAlreadyBound)
	}
	if g.Project.Directory != "" && !folder.SameDirectory(g.Project.Directory, card.Project) {
		return group.Group{}, errorcode.Coded(errorcode.GroupWorkspaceMismatch, errors.New("the workspace of the group is the one of its task"))
	}
	g.Project.Directory = card.Project
	created, err := domain.createGroup(ctx, g, members)
	if err != nil {
		return group.Group{}, err
	}
	var owner event.ID
	for _, member := range members {
		if member.Can(group.RoleOwner) {
			owner = member.ID
			break
		}
	}
	if _, err := domain.BindTask(ctx, created.ID, taskID, owner); err != nil {
		return group.Group{}, err
	}
	return created, nil
}

func (domain *Coordinator) createGroup(ctx context.Context, g group.Group, members []group.Member) (group.Group, error) {
	if _, err := leader.NewTriggers(append(leader.DefaultTriggers(), g.Settings.Triggers...)); err != nil {
		return group.Group{}, err
	}
	if g.Kind != group.KindLocal {
		if g.Kind != group.KindCloud {
			return group.Group{}, errors.New("unknown group kind")
		}
		params, _ := json.Marshal(struct {
			group.Group
			Members []group.Member `json:"members"`
		}{g, members})
		result, err := domain.remote.ForwardCloudRequest(ctx, "group.create", params)
		if err != nil {
			return group.Group{}, err
		}
		var created group.Group
		err = json.Unmarshal(result, &created)
		return created, err
	}
	domain.registry.AgentMu.Lock()
	defer domain.registry.AgentMu.Unlock()
	g.Project.Directory = registry.CanonicalDirectory(g.Project.Directory)
	if err := folder.Existing(g.Project.Directory); err != nil {
		return group.Group{}, errorcode.Coded(errorcode.WorkspaceInvalid, err)
	}
	root, rootErr := git.Root(ctx, g.Project.Directory)
	projectInfo, projectErr := os.Stat(g.Project.Directory)
	rootInfo, rootStatErr := os.Stat(root)
	if rootErr == nil && projectErr == nil && rootStatErr == nil && os.SameFile(projectInfo, rootInfo) {
		status, err := git.Status(ctx, g.Project.Directory)
		if err != nil {
			return group.Group{}, err
		}
		if g.Brief.TargetBranch == "" {
			g.Brief.TargetBranch = status.Branch
		}
		if g.Brief.TargetBranch == "" {
			return group.Group{}, errorcode.Coded(errorcode.TargetBranchInvalid, errors.New("a target branch is required for a detached repository"))
		}
		if _, err := git.Commit(ctx, g.Project.Directory, "refs/heads/"+g.Brief.TargetBranch); err != nil {
			return group.Group{}, errorcode.Coded(errorcode.TargetBranchInvalid, err)
		}
		g.Project.Remote, err = git.ProjectRemote(ctx, g.Project.Directory, g.Project.Remote)
		if err != nil {
			return group.Group{}, err
		}
	} else if g.Brief.TargetBranch != "" {
		return group.Group{}, errorcode.Coded(errorcode.TargetBranchInvalid, errors.New("a target branch requires a repository root project"))
	}
	members = append([]group.Member(nil), members...)
	var owner event.ID
	for _, member := range members {
		if member.Can(group.RoleOwner) {
			owner = member.ID
			break
		}
	}
	for i := range members {
		if members[i].Kind == group.MemberAgent && members[i].Owner == "" {
			members[i].Owner = owner
		}
	}
	for i, member := range members {
		prepared, err := domain.prepareAgentMember(ctx, member, true)
		if err != nil {
			return group.Group{}, err
		}
		members[i] = prepared
	}
	created, err := domain.groups.Create(ctx, g, members)
	if err != nil {
		return group.Group{}, err
	}
	if err := domain.StartGroup(ctx, created); err != nil {
		return group.Group{}, err
	}
	return created, nil
}
func (domain *Coordinator) AddGroupMember(ctx context.Context, id, human event.ID, member group.Member) (group.Member, error) {
	actor, err := domain.roster.GroupMember(ctx, id, human)
	if err != nil || !actor.Can(group.RoleAdmin) {
		return group.Member{}, task.ErrNotMember
	}
	if member.Kind == group.MemberHuman && member.Role == group.RoleOwner && !actor.Can(group.RoleOwner) {
		return group.Member{}, task.ErrNotMember
	}
	if member.Kind == group.MemberAgent && member.Owner == "" {
		member.Owner = human
	}
	return domain.addGroupMember(ctx, id, member, true)
}

func (domain *Coordinator) addGroupMember(ctx context.Context, id event.ID, member group.Member, acceptNetwork bool) (group.Member, error) {
	domain.registry.AgentMu.Lock()
	defer domain.registry.AgentMu.Unlock()
	member, err := domain.prepareAgentMember(ctx, member, acceptNetwork)
	if err != nil {
		return group.Member{}, err
	}
	return domain.groups.AddMember(ctx, id, member)
}

// prepareAgentMember checks that the agent of a member exists, may be used by its owner and has the role of the
// member, and fills in what the roster keeps of it: the hosts it may reach and its checkouts.
func (domain *Coordinator) prepareAgentMember(ctx context.Context, member group.Member, acceptNetwork bool) (group.Member, error) {
	member.Hosts = nil
	if member.Kind != group.MemberAgent {
		return member, nil
	}
	configured, owner, err := domain.roster.LoadAgent(ctx, member)
	if err != nil {
		return group.Member{}, err
	}
	if configured.Disabled {
		return group.Member{}, errorcode.Coded(errorcode.AgentDisabled, errors.New("the agent is turned off"))
	}
	if !configured.Shared && owner != "" && owner != member.Owner {
		return group.Member{}, errorcode.Coded(errorcode.ProfileOwnerOnly, errors.New("only the owner can use an unshared agent"))
	}
	if member.AgentRole == group.AgentLeader && configured.Product != nil {
		caps := domain.runnerFor(configured, nil).Caps()
		if !caps.MCP || !caps.Steer {
			return group.Member{}, errorcode.Coded(errorcode.ExternalLeaderUnsupported, errors.New("external leaders require MCP and steering"))
		}
	}
	if acceptNetwork {
		member.Hosts = append([]string(nil), configured.Network...)
	}
	if err := domain.remote.ConfigureMemberCheckout(ctx, &member, configured); err != nil {
		return group.Member{}, err
	}
	return member, nil
}

func (domain *Coordinator) CreateTask(ctx context.Context, card task.Card) (task.Card, error) {
	return domain.createTask(ctx, card, "")
}

func (domain *Coordinator) CreateAssignedTask(ctx context.Context, card task.Card, memberID event.ID) (task.Card, error) {
	human, err := domain.roster.GroupMember(ctx, card.Group, card.CreatedBy.ID)
	if err != nil {
		return task.Card{}, err
	}
	if !human.Can(group.RoleMember) || card.CreatedBy.Kind != event.ActorHuman || memberID == "" {
		return task.Card{}, errors.New("direct assignment requires a human creator and a worker")
	}
	return domain.createTask(ctx, card, memberID)
}

func (domain *Coordinator) createTask(ctx context.Context, card task.Card, memberID event.ID) (task.Card, error) {
	if card.Group == "" {
		return domain.createLooseTask(ctx, card)
	}
	if card.CreatedBy.Kind == event.ActorHuman {
		actor, err := domain.roster.GroupMember(ctx, card.Group, card.CreatedBy.ID)
		if err != nil || !actor.Can(group.RoleMember) {
			return task.Card{}, task.ErrNotMember
		}
	}
	state, err := domain.groups.Get(ctx, card.Group)
	if err != nil {
		return task.Card{}, err
	}
	card.Workspace, card.Base, err = domain.workspaceFor(ctx, state.Group, card.Workspace, card.Base)
	if err != nil {
		return task.Card{}, err
	}
	created, err := domain.tasks.Create(ctx, card)
	if err != nil {
		return task.Card{}, err
	}
	if memberID == "" {
		err = domain.tasks.Open(ctx, created.ID)
	} else {
		_, err = domain.tasks.OpenAndAssign(ctx, created.ID, memberID)
	}
	if err != nil {
		return task.Card{}, err
	}
	return domain.tasks.Get(ctx, created.ID)
}

// workspaceFor settles the kind of workspace of a task of the group: a worktree on its target branch when the group has
// one, and a plain folder otherwise.
func (domain *Coordinator) workspaceFor(ctx context.Context, g group.Group, kind, base string) (string, string, error) {
	if kind == "" && g.Brief.TargetBranch != "" {
		kind = workspace.KindWorktree
	}
	if kind == "" {
		kind = workspace.KindFolder
	}
	if err := checkWorkspaceKind(kind); err != nil {
		return "", "", err
	}
	if kind == workspace.KindWorktree && base == "" {
		commit, err := git.Commit(ctx, g.Project.Directory, "refs/heads/"+g.Brief.TargetBranch)
		if err != nil {
			return "", "", err
		}
		base = commit
	}
	return kind, base, nil
}

func checkWorkspaceKind(kind string) error {
	if kind != workspace.KindFolder && kind != workspace.KindWorktree && kind != workspace.KindInplace && kind != workspace.KindNone {
		return errors.New("unsupported workspace kind")
	}
	return nil
}

// createLooseTask creates a task that no group has taken yet. It lives in its own stream and wakes no Leader; its
// kind of workspace is settled when a group takes it.
func (domain *Coordinator) createLooseTask(ctx context.Context, card task.Card) (task.Card, error) {
	card.Project = registry.CanonicalDirectory(card.Project)
	if err := folder.Existing(card.Project); err != nil {
		return task.Card{}, errorcode.Coded(errorcode.WorkspaceInvalid, err)
	}
	if card.Workspace != "" {
		if err := checkWorkspaceKind(card.Workspace); err != nil {
			return task.Card{}, err
		}
	}
	created, err := domain.tasks.Create(ctx, card)
	if err != nil {
		return task.Card{}, err
	}
	if err := domain.tasks.Open(ctx, created.ID); err != nil {
		return task.Card{}, err
	}
	return domain.tasks.Get(ctx, created.ID)
}
func (domain *Coordinator) StartGroup(ctx context.Context, g group.Group) error {
	domain.mu.Lock()
	defer domain.mu.Unlock()
	if domain.core.Ctx.Err() != nil {
		return domain.core.Ctx.Err()
	}
	if domain.groupRuns[g.ID] != nil {
		return nil
	}
	triggers, err := leader.NewTriggers(append(leader.DefaultTriggers(), g.Settings.Triggers...))
	if err != nil {
		return err
	}
	facts, stop := domain.core.Bus.Subscribe(event.Filter{Scope: event.Scope{Group: g.ID}})
	run := &groupRun{group: g, state: new(leader.State), started: map[event.ID]*leaderRun{}, handovers: map[event.ID]*pendingHandover{}, handoverDone: make(chan completedHandover, 16), leaderDone: make(chan completedLeader, 16)}
	run.triggers = triggers
	run.threads = leader.NewThreads(g, run.state, domain.core.NewID)
	updates := map[event.ID]event.Event{}
	var closed []event.Event
	for {
		history, err := domain.core.Store.Read(ctx, event.Stream("group:"+g.ID), run.seq+1, 128)
		if err != nil {
			stop()
			return err
		}
		for _, fact := range history {
			if fact.Type == task.Closed {
				closed = append(closed, fact)
			}
			if fact.Type == task.Updated || fact.Type == group.Updated {
				updates[fact.Scope.Task] = fact
			}
			if fact.Type == leader.ThreadStarted || fact.Type == leader.ThreadHandedOver {
				saved, err := event.Decode[leader.Handover](fact)
				if err != nil {
					stop()
					return err
				}
				run.threads.Restore(saved, fact.Scope)
			}
			if err := run.state.Apply(fact); err != nil {
				stop()
				return err
			}
			run.seq = fact.Seq
		}
		if len(history) < 128 {
			break
		}
	}
	if err := domain.restoreLeaderInputs(ctx, run); err != nil {
		stop()
		return err
	}
	domain.groupRuns[g.ID] = run
	if err := domain.saveGroupState(ctx, run); err != nil {
		delete(domain.groupRuns, g.ID)
		stop()
		return err
	}
	if err := domain.watchGroup(ctx, g); err != nil {
		delete(domain.groupRuns, g.ID)
		stop()
		return err
	}
	domain.core.Workers.Go(func() {
		defer stop()
		for _, fact := range closed {
			if card, err := event.Decode[task.Card](fact); err == nil {
				domain.core.Workers.Go(func() { domain.extractTaskMemory(card, fact.ID) })
			}
		}
		for id, fact := range updates {
			if id == "" {
				thread := run.threads.Route(fact)
				if thread != nil && thread.Leader != g.Leader {
					domain.beginHandOver(run, thread, fact)
				}
				continue
			}
			if thread := run.threads.Route(fact); thread != nil && thread.Leader != g.Leader {
				domain.beginHandOver(run, thread, fact)
			}
		}
		for _, thread := range run.threads.List() {
			if thread.Scheduler.Pending() {
				domain.startLeader(run, thread)
			}
		}
		for {
			select {
			case <-domain.core.Ctx.Done():
				return
			case result := <-run.handoverDone:
				_ = domain.finishHandOver(domain.core.Ctx, run, result)
			case done := <-run.leaderDone:
				if run.started[done.thread.Key] == done.run && done.run.again && done.thread.Scheduler.Pending() {
					domain.startLeader(run, done.thread)
				}
			case fact, ok := <-facts:
				if !ok {
					return
				}
				if fact.Stream != event.Stream("group:"+g.ID) || fact.Seq <= run.seq {
					continue
				}
				run.seq = fact.Seq
				if fact.Type == group.Updated {
					updated, err := event.Decode[group.Group](fact)
					if err != nil {
						continue
					}
					if err := run.triggers.Update(append(leader.DefaultTriggers(), updated.Settings.Triggers...)); err != nil {
						continue
					}
					moved := run.configuration().Project.Directory != updated.Project.Directory
					run.latest.Store(&updated)
					run.threads.UpdateGroup(updated)
					thread := run.threads.Route(fact)
					if thread != nil && (thread.Leader != updated.Leader || moved) {
						domain.beginHandOver(run, thread, fact)
					} else {
						// No thread of a former Leader is running, so there is nothing to hand over
						domain.roster.DropFormerLeaders(domain.core.Ctx, updated)
					}
				}
				if err := run.state.Apply(fact); err != nil {
					continue
				}
				if err := domain.saveGroupState(domain.core.Ctx, run); err != nil {
					continue
				}
				if fact.Type == group.Paused || fact.Type == group.Resumed {
					control, err := event.Decode[group.Control](fact)
					if err != nil {
						continue
					}
					for _, thread := range run.threads.List() {
						if control.Thread != "" && control.Thread != g.ID && control.Thread != thread.Key {
							continue
						}
						if fact.Type == group.Paused {
							if active := run.started[thread.Key]; active != nil {
								active.cancel()
							}
						} else if thread.Scheduler.Pending() {
							domain.startLeader(run, thread)
						}
					}
					domain.controlGroupClaims(domain.core.Ctx, run, fact, control.Thread)
					continue
				}
				if err := domain.notifyTask(domain.core.Ctx, fact); err != nil {
					continue
				}
				if err := domain.advancePhase(domain.core.Ctx, fact); err != nil {
					continue
				}
				if fact.Type == task.QueuedEvent {
					card, err := event.Decode[task.Card](fact)
					if err == nil && len(card.Claims) > 0 {
						domain.startMember(run, card.Claims[len(card.Claims)-1].Member)
					}
				}
				if fact.Type == task.PhaseChanged {
					goal, err := event.Decode[task.Card](fact)
					if err == nil && goal.Phase == task.PhaseDoing {
						cards, err := domain.tasks.List(domain.core.Ctx, g.ID)
						if err == nil {
							for _, card := range cards {
								root, err := domain.roster.TaskRoot(domain.core.Ctx, card)
								if err != nil || root != goal.ID {
									continue
								}
								for _, claim := range card.Claims {
									if claim.Status == task.ClaimQueued {
										domain.startMember(run, claim.Member)
									}
								}
							}
						}
					}
				}
				if fact.Type == task.Reported || fact.Type == task.Reviewed || fact.Type == task.Updated {
					card, err := event.Decode[task.Card](fact)
					if err == nil {
						for _, claim := range card.Claims {
							domain.startMember(run, claim.Member)
						}
					}
				}
				if fact.Type == task.Closed {
					card, err := event.Decode[task.Card](fact)
					if err == nil {
						domain.core.Workers.Go(func() { domain.extractTaskMemory(card, fact.ID) })
					}
					if err == nil && card.Status == task.Cancelled {
						if card.Parent == "" && run.started[run.group.ID] != nil && !domain.otherOpenGoal(domain.core.Ctx, run.group.ID, card.ID) {
							run.started[run.group.ID].cancel()
						}
						for _, claim := range card.Claims {
							running, ok := domain.execution.ClaimToCancel(claim.ID)
							if ok {
								_ = running.Run.Cancel(domain.core.Ctx)
							}
							domain.startMember(run, claim.Member)
						}
					}
					if err == nil && card.Status == task.Done && card.Parent == "" {
						_ = domain.releaseGoalWorkspaces(domain.core.Ctx, card)
					}
				}
				if fact.Type == workspace.MergeDone {
					if err := domain.completeIntegration(domain.core.Ctx, fact); err != nil {
						continue
					}
				}
				if environmental(fact) && run.configuration().Settings.Initiative == group.Passive {
					run.threads.Route(fact).Scheduler.Inform(fact)
					continue
				}
				if handled, err := domain.applyTriggers(domain.core.Ctx, run, fact); handled || err != nil {
					continue
				}
				if environmental(fact) {
					_ = domain.routeEnvironment(domain.core.Ctx, run, fact)
					continue
				}
				if domain.routeTaskChange(domain.core.Ctx, run, fact) {
					continue
				}
				if fact.Type == task.QueuedEvent && fact.Actor.Kind == event.ActorAgent && fact.Actor.ID != run.configuration().Leader {
					// A Worker took a task for itself: the Leader needs to know who holds it now.
					if thread := run.threads.Route(fact); thread != nil {
						thread.Scheduler.EnqueuePriority(fact, leader.PriorityNormal)
						domain.startLeader(run, thread)
					}
					continue
				}
				if !leaderInputType(fact.Type) {
					continue
				}
				assigned := false
				if fact.Type == task.Opened {
					card, err := event.Decode[task.Card](fact)
					if err != nil || card.Parent != "" {
						continue
					}
					if triggerActor(card.CreatedBy) {
						run.threads.Route(fact).Scheduler.Inform(fact)
						continue
					}
					current, err := domain.tasks.Get(domain.core.Ctx, card.ID)
					assigned = err == nil && len(current.Claims) > 0
				}
				thread := run.threads.Route(fact)
				if thread == nil {
					continue
				}
				if fact.Type == question.Answered {
					asked, err := domain.core.Store.Get(domain.core.Ctx, fact.Cause)
					if err == nil && asked.Stream != event.Stream("group:"+g.ID) {
						thread.Scheduler.Inform(fact)
						continue
					}
				}
				if assigned || fact.Type == group.HumanSaid && domain.forwardHuman(domain.core.Ctx, run, fact) {
					// The human's word already went to the member; the Leader wakes to update its plan.
					thread.Scheduler.EnqueuePriority(fact, leader.PriorityNormal)
					domain.startLeader(run, thread)
					continue
				}
				thread.Scheduler.Enqueue(fact)
				domain.startLeader(run, thread)
			}
		}
	})
	return nil
}

func (domain *Coordinator) saveGroupState(ctx context.Context, g *groupRun) error {
	doc, err := domain.core.Store.Fetch(ctx, "group-state", string(g.group.ID))
	if err != nil && !errors.Is(err, store.ErrNotFound) {
		return err
	}
	body, err := json.Marshal(g.state.Snapshot())
	if err != nil {
		return err
	}
	return domain.core.Store.Put(ctx, store.Doc{Kind: "group-state", Key: string(g.group.ID), Rev: doc.Rev, Body: body})
}
func (domain *Coordinator) GroupState(ctx context.Context, id event.ID) (leader.View, error) {
	doc, err := domain.core.Store.Fetch(ctx, "group-state", string(id))
	if err != nil {
		return leader.View{}, err
	}
	var view leader.View
	err = json.Unmarshal(doc.Body, &view)
	return view, err
}

func (domain *Coordinator) startMember(g *groupRun, memberID event.ID) {
	claim, err := domain.tasks.Next(domain.core.Ctx, memberID)
	if err != nil {
		return
	}
	domain.mu.Lock()
	defer domain.mu.Unlock()
	if domain.core.Ctx.Err() == nil {
		domain.core.Workers.Go(func() { domain.startClaim(g, claim) })
	}
}

// startClaim runs a claim; restart carries the human words a stopped run did not see.
func (domain *Coordinator) startClaim(g *groupRun, claim task.Claim, restart ...loop.Input) {
	ctx, cancel := context.WithCancel(domain.core.Ctx)
	started := false
	domain.execution.PrepareClaim(claim.ID, cancel)
	defer func() {
		domain.execution.ForgetPreparation(claim.ID)
		if !started {
			cancel()
		}
	}()
	memberID := claim.Member
	card, err := domain.tasks.Get(ctx, claim.Task)
	if err != nil {
		return
	}
	if card.Status == task.Cancelled || card.Status == task.Done || card.Status == task.Failed {
		return
	}
	member, err := domain.roster.GroupMember(domain.core.Ctx, g.group.ID, memberID)
	if err != nil {
		return
	}
	p, err := domain.roster.MemberAgent(domain.core.Ctx, member)
	if err != nil {
		return
	}
	workdir := g.configuration().Project.Directory
	if check := g.configuration().Brief.Check; check != "" {
		p.System += "\nRun the group's check command before submitting your report: " + check
	}
	if card.Workspace != "" && (p.Product == nil || p.Product.Kind != definition.KindRemote) {
		var ws workspace.Workspace
		var err error
		ws, err = domain.workspaces.ForClaim(ctx, workdir, claim, card)
		if err == nil && claim.Workspace == "" {
			err = domain.tasks.BindWorkspace(domain.core.Ctx, claim.ID, ws.ID)
		}
		if err != nil {
			if ws.ID != "" {
				_ = domain.workspaces.EndClaim(domain.core.Ctx, ws)
			}
			_ = domain.tasks.Submit(domain.core.Ctx, worker.ReportFromText(claim.ID, "Worker workspace could not be created.", loop.Failed, err))
			return
		}
		claim.Workspace, workdir = ws.ID, ws.Directory
		state, err := domain.groups.Get(domain.core.Ctx, card.Group)
		if err == nil {
			err = domain.execution.SetupWorkspace(ctx, p, worker.Assignment{Claim: claim, Session: claim.Session, Scope: event.Scope{Group: card.Group, Task: card.ID}, Workdir: workdir}, ws, state.Group.Settings.Setup)
		}
		if err != nil {
			_ = domain.workspaces.EndClaim(domain.core.Ctx, ws)
			if ctx.Err() != nil {
				return
			}
			_ = domain.tasks.Block(domain.core.Ctx, card.ID)
			_ = domain.tasks.Submit(domain.core.Ctx, task.Report{Claim: claim.ID, Verdict: task.VerdictBlocked, Summary: "MRK-5011"})
			return
		}
		if card.Workspace == workspace.KindWorktree {
			p.System += "\nYou work in an isolated Git worktree. Stay within the task areas and your claim scope. Verify your changes and commit them on the assigned branch before submitting your report. Do not merge into or switch the target branch."
		} else if card.Workspace == workspace.KindFolder {
			p.System += "\nYou work in an isolated folder containing only the task's declared input files. Write outputs here and declare their relative paths in the report's artifacts. Do not copy results into the original project."
		} else if card.Workspace == workspace.KindNone {
			p.ToolPool = "worker.readonly"
			p.System += "\nThis is a research task. File access is read-only. Return your findings in the report."
		}
	}
	assignment := worker.Assignment{Claim: claim, Session: claim.Session, Scope: event.Scope{Group: card.Group, Task: card.ID}, Workdir: workdir}
	var words []string
	for _, input := range restart {
		for _, part := range input.Parts {
			words = append(words, part.Text)
		}
		if input.Cause != "" {
			assignment.Cause = input.Cause
		}
	}
	assignment.Packet = strings.Join(words, "\n")
	run, err := domain.execution.StartWorker(ctx, p, assignment)
	if err != nil {
		if claim.Workspace != "" {
			if ws, err := domain.workspaces.Get(domain.core.Ctx, claim.Workspace); err == nil {
				_ = domain.workspaces.EndClaim(domain.core.Ctx, ws)
			}
		}
		_ = domain.tasks.Submit(domain.core.Ctx, worker.ReportFromText(claim.ID, "Worker could not start.", loop.Failed, err))
		return
	}
	started = true
	domain.execution.FinishPreparation(claim.ID, func() {
		defer cancel()
		report, runErr := run.Wait(context.Background())
		restarting := false
		defer func() {
			if !restarting {
				domain.execution.ForgetClaim(claim.ID)
			}
		}()
		if inputs := domain.takeClaimRestart(claim.ID); len(inputs) > 0 && domain.core.Ctx.Err() == nil {
			restarting = true
			domain.execution.ForgetClaim(claim.ID)
			domain.core.Workers.Go(func() { domain.startClaim(g, claim, inputs...) })
			return
		}
		ending, cancel := context.WithTimeout(context.WithoutCancel(domain.core.Ctx), 5*time.Second)
		defer cancel()
		if claim.Workspace != "" {
			if ws, err := domain.workspaces.Get(ending, claim.Workspace); err == nil {
				_ = domain.workspaces.EndClaim(ending, ws)
			}
		}
		if runErr != nil && report.Synthesized {
			_ = domain.flagFinding(ending, card.Group, leader.Finding{Rule: "claim.exited", Code: "MRK-6002", Claim: claim.ID, Task: card.ID, Member: claim.Member, Session: claim.Session, Action: "interrupt"})
			return
		}
		_ = domain.tasks.Submit(ending, report)
	})
	current, err := domain.tasks.Get(domain.core.Ctx, card.ID)
	if err == nil && current.Status == task.Cancelled {
		_ = run.Cancel(domain.core.Ctx)
	}
}
func (domain *Coordinator) startLeader(g *groupRun, thread *leader.Thread) {
	state, err := domain.groups.Get(domain.core.Ctx, g.group.ID)
	if err != nil || state.IsPaused(thread.Key) {
		return
	}
	if g.handovers[thread.Key] != nil {
		return
	}
	if prior := g.started[thread.Key]; prior != nil {
		select {
		case <-prior.done:
			delete(g.started, thread.Key)
		default:
			prior.again = true
			return
		}
	}
	ctx, cancel := context.WithCancel(domain.core.Ctx)
	run := &leaderRun{cancel: cancel, done: make(chan struct{})}
	g.started[thread.Key] = run
	id := thread.Session.Read().ID
	if !domain.execution.StartGroupSession(id, func() {
		defer func() {
			close(run.done)
			select {
			case g.leaderDone <- completedLeader{thread: thread, run: run}:
			case <-domain.core.Ctx.Done():
			}
		}()
		defer cancel()
		defer domain.execution.EndGroupSession(id)
		domain.runLeader(ctx, g, thread)
	}) {
		delete(g.started, thread.Key)
		cancel()
	}
}

func (domain *Coordinator) runLeader(ctx context.Context, g *groupRun, thread *leader.Thread) {
	ctx, fail := context.WithCancelCause(ctx)
	defer fail(nil)
	defer func() {
		if cause := context.Cause(ctx); cause != nil && !errors.Is(cause, context.Canceled) && !errors.Is(cause, context.DeadlineExceeded) {
			domain.pauseLeader(context.WithoutCancel(ctx), g.group.ID, thread)
		}
	}()
	member, err := domain.roster.GroupMember(ctx, g.group.ID, thread.Leader)
	if err != nil {
		fail(err)
		return
	}
	p, err := domain.roster.MemberAgent(ctx, member)
	if err != nil {
		fail(err)
		return
	}
	digest := leader.Digest{State: g.state, Focus: thread.Session.Read().Scope.Task}
	thread.Scheduler.SetDigest(digest)
	var runtime leaderRuntime
	if p.Product != nil {
		runtime, err = domain.externalLeaderRuntime(ctx, g, thread, p, fail)
	} else {
		runtime, err = domain.builtinLeaderRuntime(ctx, g, thread, p)
	}
	if err != nil {
		fail(err)
		return
	}
	defer runtime.Close()
	initial := len(thread.Session.Read().Messages) == 0
	for {
		batch, err := thread.Scheduler.NextBatch(ctx)
		if err != nil {
			return
		}
		input := digest.Render(batch)
		if initial {
			body, _ := json.Marshal(g.configuration().Brief)
			text := "## Group brief\n" + string(body)
			if thread.Handover != "" {
				text += "\n## Handover\n" + thread.Handover
			}
			input.Parts = append([]model.Part{{Text: text}}, input.Parts...)
			initial = false
		}
		if err := runtime.Send(ctx, input); err != nil {
			for _, fact := range batch {
				thread.Scheduler.Enqueue(fact)
			}
			fail(err)
			return
		}
		if p.Product == nil && !thread.Scheduler.Pending() { // only a built-in Leader has a known end of turn
			domain.inviteIdleWorkers(g)
		}
	}
}

func (domain *Coordinator) builtinLeaderRuntime(ctx context.Context, g *groupRun, thread *leader.Thread, p definition.Agent) (leaderRuntime, error) {
	saved, loadErr := domain.manager.Load(ctx, thread.Session.Read().ID)
	if loadErr != nil && !errors.Is(loadErr, store.ErrNotFound) {
		return nil, loadErr
	}
	var c *conversation.Conversation
	var err error
	if loadErr == nil {
		c, err = domain.conversation.ConversationFor(saved)
	} else {
		var chosen definition.ModelRef
		if chosen, err = domain.registry.MemberModel(p.Model); err != nil {
			return nil, err
		}
		c, err = domain.conversation.NewConversation(ctx, conversation.SessionOptions{ID: thread.Session.Read().ID, Scope: thread.Session.Read().Scope, Member: thread.Leader, Role: "leader", Mode: p.Mode, Provider: chosen.Provider, Model: chosen.Model, Thinking: chosen.Thinking, Workdir: g.configuration().Project.Directory, System: p.System, ToolPool: "leader.default", Budget: p.Budget})
	}
	if err != nil {
		return nil, err
	}
	runtime := &builtinLeader{owner: domain, conversation: c}
	var final []model.Part
	c.Runner.Steer = execution.JoinedSteer{First: thread.Scheduler, Second: c.Runner.Steer}
	c.Runner.Tools = c.Runner.Tools.With(domain.leaderTools(g, thread, func(text string) { final = []model.Part{{Text: text}} })...)
	c.State.SetTools(c.Runner.Tools.Specs(), "")
	c.Runner.Finish = func() []model.Part { return final }
	runtime.reset = func() { final = nil }
	if loadErr != nil {
		created, err := domain.manager.Create(ctx, *c.State)
		if err != nil {
			runtime.Close()
			return nil, err
		}
		c.State = created
		body, _ := json.Marshal(leader.Handover{Key: thread.Key, Leader: thread.Leader, Session: c.State.Read().ID})
		if _, err := domain.core.Bus.Publish(ctx, event.Event{Stream: event.Stream("group:" + g.group.ID), Scope: c.State.Read().Scope, Type: leader.ThreadStarted, Actor: event.Actor{Kind: event.ActorAgent, ID: thread.Leader}, Payload: body}); err != nil {
			runtime.Close()
			return nil, err
		}
	}
	thread.Session = c.State
	return runtime, nil
}

// otherOpenGoal reports whether the group has a goal besides the given one that is still being worked on.
func (domain *Coordinator) otherOpenGoal(ctx context.Context, groupID, except event.ID) bool {
	cards, err := domain.tasks.List(ctx, groupID)
	if err != nil {
		return true
	}
	return slices.ContainsFunc(cards, func(card task.Card) bool {
		return card.Parent == "" && card.ID != except && card.Phase != task.PhaseDone && card.Phase != task.PhaseCancelled
	})
}

// GroupTasks lists all tasks of a group, including archived tasks.
func (domain *Coordinator) GroupTasks(ctx context.Context, groupID event.ID) ([]task.Card, error) {
	return domain.tasks.List(ctx, groupID)
}

func (domain *Coordinator) Workspace(ctx context.Context, id event.ID) (workspace.Workspace, error) {
	return domain.workspaces.Get(ctx, id)
}

// ListTasks gives the tasks of every group, and the ones that have no group yet.
func (domain *Coordinator) ListTasks(ctx context.Context, filter task.Filter) ([]task.Card, error) {
	filter.Project = registry.CanonicalDirectory(filter.Project)
	return domain.tasks.Find(ctx, filter)
}

// ArchiveTasks hides finished tasks from the board, or brings them back.
func (domain *Coordinator) ArchiveTasks(ctx context.Context, ids []event.ID, archived bool, actor event.Actor) ([]task.Card, error) {
	cards, err := domain.tasks.Archive(ctx, ids, archived, actor)
	if errors.Is(err, task.ErrNotFinished) {
		return nil, errorcode.Coded(errorcode.TaskNotFinished, err)
	}
	return cards, err
}

func (domain *Coordinator) RemoveGroupMember(ctx context.Context, id, human, member event.ID) error {
	return domain.tasks.RemoveMember(ctx, id, human, member)
}

func (domain *Coordinator) RenameGroupMember(ctx context.Context, id, human, member event.ID, name string) (group.Member, error) {
	return domain.groups.RenameMember(ctx, id, human, member, name)
}

func (domain *Coordinator) BoardGroups(ctx context.Context, human event.ID) ([]group.Listing, error) {
	return domain.board.Groups(ctx, human)
}

func (domain *Coordinator) Task(ctx context.Context, id event.ID) (task.Card, error) {
	return domain.tasks.Get(ctx, id)
}
