package engine

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"os"
	"sync/atomic"
	"time"

	"github.com/TongTong313/merakcode/merak/engine/event"
	"github.com/TongTong313/merakcode/merak/engine/group"
	"github.com/TongTong313/merakcode/merak/engine/leader"
	"github.com/TongTong313/merakcode/merak/engine/loop"
	"github.com/TongTong313/merakcode/merak/engine/model"
	"github.com/TongTong313/merakcode/merak/engine/profile"
	"github.com/TongTong313/merakcode/merak/engine/question"
	"github.com/TongTong313/merakcode/merak/engine/store"
	"github.com/TongTong313/merakcode/merak/engine/task"
	"github.com/TongTong313/merakcode/merak/engine/worker"
	"github.com/TongTong313/merakcode/merak/engine/workspace"
	"github.com/TongTong313/merakcode/merak/internal/platform/errorcode"
	"github.com/TongTong313/merakcode/merak/internal/platform/git"
)

type groupRun struct {
	latest       atomic.Pointer[group.Group]
	limits       *leader.TurnLimiter
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

func (e *Engine) CreateGroup(ctx context.Context, g group.Group, members []group.Member, profiles []profile.Profile) (group.Group, error) {
	if _, err := leader.NewTriggers(append(leader.DefaultTriggers(), g.Settings.Triggers...)); err != nil {
		return group.Group{}, err
	}
	if g.Kind != group.KindLocal {
		if g.Kind != group.KindCloud {
			return group.Group{}, errors.New("unknown group kind")
		}
		params, _ := json.Marshal(struct {
			group.Group
			Members  []group.Member    `json:"members"`
			Profiles []profile.Profile `json:"profiles"`
		}{g, members, profiles})
		result, err := e.forwardCloud(ctx, "group.create", params)
		if err != nil {
			return group.Group{}, err
		}
		var created group.Group
		err = json.Unmarshal(result, &created)
		return created, err
	}
	e.profileMu.Lock()
	defer e.profileMu.Unlock()
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
			return group.Group{}, coded(errorcode.TargetBranchInvalid, errors.New("a target branch is required for a detached repository"))
		}
		if _, err := git.Commit(ctx, g.Project.Directory, "refs/heads/"+g.Brief.TargetBranch); err != nil {
			return group.Group{}, coded(errorcode.TargetBranchInvalid, err)
		}
		g.Project.Remote, err = git.ProjectRemote(ctx, g.Project.Directory, g.Project.Remote)
		if err != nil {
			return group.Group{}, err
		}
	} else if g.Brief.TargetBranch != "" {
		return group.Group{}, coded(errorcode.TargetBranchInvalid, errors.New("a target branch requires a repository root project"))
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
	for _, p := range profiles {
		profileOwner := owner
		for _, member := range members {
			if member.Profile == p.ID {
				profileOwner = member.Owner
				break
			}
		}
		if err := e.saveGroupProfile(ctx, p, profileOwner); err != nil {
			return group.Group{}, err
		}
	}
	for i, member := range members {
		if member.Kind != group.MemberAgent {
			continue
		}
		p, err := e.memberProfile(ctx, member)
		if err != nil {
			return group.Group{}, err
		}
		if string(p.Role) != string(member.AgentRole) {
			return group.Group{}, coded(errorcode.MemberRoleMismatch, errors.New("member role must match its profile"))
		}
		if member.AgentRole == group.AgentLeader && p.Product != nil {
			caps := e.runnerFor(p, nil).Caps()
			if !caps.MCP || !caps.Steer {
				return group.Group{}, coded(errorcode.ExternalLeaderUnsupported, errors.New("external leaders require MCP and steering"))
			}
		}
		members[i].Hosts = append([]string(nil), p.Network...)
		if err := e.configureMemberCheckout(ctx, &members[i], p); err != nil {
			return group.Group{}, err
		}
	}
	created, err := e.Groups.Create(ctx, g, members)
	if err != nil {
		return group.Group{}, err
	}
	if err := e.startGroup(ctx, created); err != nil {
		return group.Group{}, err
	}
	return created, nil
}
func (e *Engine) saveGroupProfile(ctx context.Context, p profile.Profile, owner event.ID) error {
	if err := validateProfileNetwork(p); err != nil {
		return err
	}
	if p.ID == "" || p.Role != profile.Leader && p.Role != profile.Worker {
		return errors.New("profile id and role are required")
	}
	body, err := json.Marshal(p)
	if err != nil {
		return err
	}
	existing, err := e.store.Fetch(ctx, "profile", string(p.ID))
	if err == nil {
		if bytes.Equal(existing.Body, body) {
			return nil
		}
		return store.ErrConflict
	}
	if !errors.Is(err, store.ErrNotFound) {
		return err
	}
	return e.store.Put(ctx, store.Doc{Kind: "profile", Key: string(p.ID), Body: body, Meta: map[string]string{"owner": string(owner)}})
}
func (e *Engine) AddGroupMember(ctx context.Context, id, human event.ID, member group.Member, p *profile.Profile) (group.Member, error) {
	actor, err := e.groupMember(ctx, id, human)
	if err != nil || !actor.Can(group.RoleAdmin) {
		return group.Member{}, task.ErrNotMember
	}
	if member.Kind == group.MemberHuman && member.Role == group.RoleOwner && !actor.Can(group.RoleOwner) {
		return group.Member{}, task.ErrNotMember
	}
	if member.Kind == group.MemberAgent && member.Owner == "" {
		member.Owner = human
	}
	return e.addGroupMember(ctx, id, member, p, true)
}

func (e *Engine) addGroupMember(ctx context.Context, id event.ID, member group.Member, p *profile.Profile, acceptNetwork bool) (group.Member, error) {
	e.profileMu.Lock()
	defer e.profileMu.Unlock()
	member.Hosts = nil
	if p != nil {
		if string(p.Role) != string(member.AgentRole) {
			return group.Member{}, coded(errorcode.MemberRoleMismatch, errors.New("member role must match its profile"))
		}
		if err := e.saveGroupProfile(ctx, *p, member.Owner); err != nil {
			return group.Member{}, err
		}
		member.Profile = p.ID
	}
	if member.Kind == group.MemberAgent {
		configured, err := e.memberProfile(ctx, member)
		if err != nil {
			return group.Member{}, err
		}
		if string(configured.Role) != string(member.AgentRole) {
			return group.Member{}, coded(errorcode.MemberRoleMismatch, errors.New("member role must match its profile"))
		}
		if member.AgentRole == group.AgentLeader && configured.Product != nil {
			caps := e.runnerFor(configured, nil).Caps()
			if !caps.MCP || !caps.Steer {
				return group.Member{}, coded(errorcode.ExternalLeaderUnsupported, errors.New("external leaders require MCP and steering"))
			}
		}
		if acceptNetwork {
			member.Hosts = append([]string(nil), configured.Network...)
		}
		if err := e.configureMemberCheckout(ctx, &member, configured); err != nil {
			return group.Member{}, err
		}
	}
	return e.Groups.AddMember(ctx, id, member)
}
func (e *Engine) memberProfile(ctx context.Context, member group.Member) (profile.Profile, error) {
	for _, p := range defaultProfiles() {
		if p.ID == member.Profile || member.Profile == "" && string(p.Role) == string(member.AgentRole) {
			return p, nil
		}
	}
	doc, err := e.store.Fetch(ctx, "profile", string(member.Profile))
	if err != nil {
		return profile.Profile{}, err
	}
	if doc.Meta["deleted"] == "true" {
		return profile.Profile{}, store.ErrNotFound
	}
	var p profile.Profile
	err = json.Unmarshal(doc.Body, &p)
	return p, err
}
func (e *Engine) CreateTask(ctx context.Context, card task.Card) (task.Card, error) {
	return e.createTask(ctx, card, "")
}

func (e *Engine) CreateAssignedTask(ctx context.Context, card task.Card, memberID event.ID) (task.Card, error) {
	human, err := e.groupMember(ctx, card.Group, card.CreatedBy.ID)
	if err != nil {
		return task.Card{}, err
	}
	if !human.Can(group.RoleMember) || card.CreatedBy.Kind != event.ActorHuman || memberID == "" {
		return task.Card{}, errors.New("direct assignment requires a human creator and a worker")
	}
	return e.createTask(ctx, card, memberID)
}

func (e *Engine) createTask(ctx context.Context, card task.Card, memberID event.ID) (task.Card, error) {
	if card.CreatedBy.Kind == event.ActorHuman {
		actor, err := e.groupMember(ctx, card.Group, card.CreatedBy.ID)
		if err != nil || !actor.Can(group.RoleMember) {
			return task.Card{}, task.ErrNotMember
		}
	}
	state, err := e.Groups.Get(ctx, card.Group)
	if err != nil {
		return task.Card{}, err
	}
	if card.Workspace == "" && state.Group.Brief.TargetBranch != "" {
		card.Workspace = workspace.KindWorktree
	}
	if card.Workspace == "" {
		card.Workspace = workspace.KindFolder
	}
	if card.Workspace != workspace.KindFolder && card.Workspace != workspace.KindWorktree && card.Workspace != workspace.KindInplace && card.Workspace != workspace.KindNone {
		return task.Card{}, errors.New("unsupported workspace kind")
	}
	if card.Workspace == workspace.KindWorktree && card.Base == "" {
		card.Base, err = git.Commit(ctx, state.Group.Project.Directory, "refs/heads/"+state.Group.Brief.TargetBranch)
		if err != nil {
			return task.Card{}, err
		}
	}
	created, err := e.Tasks.Create(ctx, card)
	if err != nil {
		return task.Card{}, err
	}
	if memberID == "" {
		err = e.Tasks.Open(ctx, created.ID)
	} else {
		_, err = e.Tasks.OpenAndAssign(ctx, created.ID, memberID)
	}
	if err != nil {
		return task.Card{}, err
	}
	return e.Tasks.Get(ctx, created.ID)
}
func (e *Engine) startGroup(ctx context.Context, g group.Group) error {
	e.mu.Lock()
	defer e.mu.Unlock()
	if e.ctx.Err() != nil {
		return e.ctx.Err()
	}
	if e.groupRuns[g.ID] != nil {
		return nil
	}
	triggers, err := leader.NewTriggers(append(leader.DefaultTriggers(), g.Settings.Triggers...))
	if err != nil {
		return err
	}
	facts, stop := e.Bus.Subscribe(event.Filter{Scope: event.Scope{Group: g.ID}})
	run := &groupRun{group: g, state: new(leader.State), started: map[event.ID]*leaderRun{}, handovers: map[event.ID]*pendingHandover{}, handoverDone: make(chan completedHandover, 16), leaderDone: make(chan completedLeader, 16)}
	run.triggers = triggers
	run.threads = leader.NewThreads(g, run.state, e.newID)
	run.limits = leader.NewTurnLimiter(e.now, run.threads.Wake)
	updates := map[event.ID]event.Event{}
	var closed []event.Event
	for {
		history, err := e.store.Read(ctx, event.Stream("group:"+g.ID), run.seq+1, 128)
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
	if err := e.restoreLeaderInputs(ctx, run); err != nil {
		stop()
		return err
	}
	e.groupRuns[g.ID] = run
	if err := e.saveGroupState(ctx, run); err != nil {
		delete(e.groupRuns, g.ID)
		stop()
		return err
	}
	if err := e.watchGroup(ctx, g); err != nil {
		delete(e.groupRuns, g.ID)
		stop()
		return err
	}
	e.workers.Go(func() {
		defer stop()
		for _, fact := range closed {
			if card, err := event.Decode[task.Card](fact); err == nil {
				e.workers.Go(func() { e.extractTaskMemory(card, fact.ID) })
			}
		}
		for id, fact := range updates {
			if id == "" {
				thread := run.threads.Route(fact)
				if thread != nil && thread.Leader != g.DefaultLeader {
					e.beginHandOver(run, thread, fact)
				}
				continue
			}
			card, err := e.Tasks.Get(e.ctx, id)
			if err != nil || card.Parent != "" || card.Phase == task.PhaseDone || card.Phase == task.PhaseCancelled {
				continue
			}
			thread := run.threads.Route(fact)
			if thread != nil && thread.Leader != card.Leader {
				e.beginHandOver(run, thread, fact)
			}
		}
		for _, thread := range run.threads.List() {
			if thread.Scheduler.Pending() {
				e.startLeader(run, thread)
			}
		}
		for {
			select {
			case <-e.ctx.Done():
				return
			case result := <-run.handoverDone:
				_ = e.finishHandOver(e.ctx, run, result)
			case done := <-run.leaderDone:
				if run.started[done.thread.Key] == done.run && done.run.again && done.thread.Scheduler.Pending() {
					e.startLeader(run, done.thread)
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
					run.latest.Store(&updated)
					run.threads.UpdateGroup(updated)
					thread := run.threads.Route(fact)
					if thread != nil && thread.Leader != updated.DefaultLeader {
						e.beginHandOver(run, thread, fact)
					}
					run.threads.Wake()
				}
				if err := run.state.Apply(fact); err != nil {
					continue
				}
				if err := e.saveGroupState(e.ctx, run); err != nil {
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
							e.startLeader(run, thread)
						}
					}
					e.controlGroupClaims(e.ctx, run, fact, control.Thread)
					continue
				}
				if fact.Type == task.Updated {
					card, err := event.Decode[task.Card](fact)
					if err == nil && card.Parent == "" {
						thread := run.threads.Route(fact)
						if thread != nil && thread.Leader != card.Leader {
							e.beginHandOver(run, thread, fact)
						}
					}
				}
				if err := e.notifyTask(e.ctx, fact); err != nil {
					continue
				}
				if err := e.advancePhase(e.ctx, fact); err != nil {
					continue
				}
				if fact.Type == task.QueuedEvent {
					card, err := event.Decode[task.Card](fact)
					if err == nil && len(card.Claims) > 0 {
						e.startMember(run, card.Claims[len(card.Claims)-1].Member)
					}
				}
				if fact.Type == task.PhaseChanged {
					goal, err := event.Decode[task.Card](fact)
					if err == nil && goal.Phase == task.PhaseDoing {
						cards, err := e.Tasks.List(e.ctx, g.ID)
						if err == nil {
							for _, card := range cards {
								root, err := e.taskRoot(e.ctx, card)
								if err != nil || root != goal.ID {
									continue
								}
								for _, claim := range card.Claims {
									if claim.Status == task.ClaimQueued {
										e.startMember(run, claim.Member)
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
							e.startMember(run, claim.Member)
						}
					}
				}
				if fact.Type == task.Closed {
					card, err := event.Decode[task.Card](fact)
					if err == nil {
						e.workers.Go(func() { e.extractTaskMemory(card, fact.ID) })
					}
					if err == nil && card.Status == task.Cancelled {
						if card.Parent == "" && run.started[card.ID] != nil {
							run.started[card.ID].cancel()
						}
						for _, claim := range card.Claims {
							e.mu.Lock()
							running, ok := e.claimRuns[claim.ID]
							if preparing := e.claimPreparing[claim.ID]; preparing != nil {
								preparing.cancel()
							}
							e.mu.Unlock()
							if ok {
								_ = running.run.Cancel(e.ctx)
							}
							e.startMember(run, claim.Member)
						}
					}
					if err == nil && card.Status == task.Done && card.Parent == "" {
						_ = e.releaseGoalWorkspaces(e.ctx, card)
					}
				}
				if fact.Type == workspace.MergeDone {
					if err := e.completeIntegration(e.ctx, fact); err != nil {
						continue
					}
				}
				if environmental(fact) && run.configuration().Settings.Initiative == group.Passive {
					run.threads.Route(fact).Scheduler.Inform(fact)
					continue
				}
				if handled, err := e.applyTriggers(e.ctx, run, fact); handled || err != nil {
					continue
				}
				if environmental(fact) {
					_ = e.routeEnvironment(e.ctx, run, fact)
					continue
				}
				if e.routeTaskChange(e.ctx, run, fact) {
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
					current, err := e.Tasks.Get(e.ctx, card.ID)
					assigned = err == nil && len(current.Claims) > 0
				}
				thread := run.threads.Route(fact)
				if thread == nil {
					continue
				}
				if fact.Type == question.Answered {
					asked, err := e.store.Get(e.ctx, fact.Cause)
					if err == nil && asked.Stream != event.Stream("group:"+g.ID) {
						thread.Scheduler.Inform(fact)
						continue
					}
				}
				if assigned {
					thread.Scheduler.Inform(fact)
					continue
				}
				if fact.Type == group.HumanSaid && e.forwardHuman(e.ctx, run, fact) {
					thread.Scheduler.Inform(fact)
					continue
				}
				thread.Scheduler.Enqueue(fact)
				e.startLeader(run, thread)
			}
		}
	})
	return nil
}

func (e *Engine) saveGroupState(ctx context.Context, g *groupRun) error {
	doc, err := e.store.Fetch(ctx, "group-state", string(g.group.ID))
	if err != nil && !errors.Is(err, store.ErrNotFound) {
		return err
	}
	body, err := json.Marshal(g.state.Snapshot())
	if err != nil {
		return err
	}
	return e.store.Put(ctx, store.Doc{Kind: "group-state", Key: string(g.group.ID), Rev: doc.Rev, Body: body})
}
func (e *Engine) GroupState(ctx context.Context, id event.ID) (leader.View, error) {
	doc, err := e.store.Fetch(ctx, "group-state", string(id))
	if err != nil {
		return leader.View{}, err
	}
	var view leader.View
	err = json.Unmarshal(doc.Body, &view)
	return view, err
}
func (e *Engine) groupMember(ctx context.Context, groupID, memberID event.ID) (group.Member, error) {
	state, err := e.Groups.Get(ctx, groupID)
	if err != nil {
		return group.Member{}, err
	}
	for _, member := range state.Members {
		if member.ID == memberID {
			return member, nil
		}
	}
	return group.Member{}, store.ErrNotFound
}
func (e *Engine) startMember(g *groupRun, memberID event.ID) {
	claim, err := e.Tasks.Next(e.ctx, memberID)
	if err != nil {
		return
	}
	e.mu.Lock()
	defer e.mu.Unlock()
	if e.ctx.Err() == nil {
		e.workers.Go(func() { e.startClaim(g, claim) })
	}
}

func (e *Engine) startClaim(g *groupRun, claim task.Claim) {
	ctx, cancel := context.WithCancel(e.ctx)
	started := false
	e.mu.Lock()
	e.claimPreparing[claim.ID] = &claimPreparation{cancel: cancel}
	e.mu.Unlock()
	defer func() {
		e.mu.Lock()
		delete(e.claimPreparing, claim.ID)
		e.mu.Unlock()
		if !started {
			cancel()
		}
	}()
	memberID := claim.Member
	card, err := e.Tasks.Get(ctx, claim.Task)
	if err != nil {
		return
	}
	if card.Status == task.Cancelled || card.Status == task.Done || card.Status == task.Failed {
		return
	}
	member, err := e.groupMember(e.ctx, g.group.ID, memberID)
	if err != nil {
		return
	}
	p, err := e.memberProfile(e.ctx, member)
	if err != nil {
		return
	}
	workdir := g.group.Project.Directory
	if check := g.configuration().Brief.Check; check != "" {
		p.System += "\nRun the group's check command before submitting your report: " + check
	}
	if card.Workspace != "" && (p.Product == nil || p.Product.Kind != worker.KindRemote) {
		var ws workspace.Workspace
		var err error
		ws, err = e.Workspaces.ForClaim(ctx, workdir, claim, card)
		if err == nil && claim.Workspace == "" {
			err = e.Tasks.BindWorkspace(e.ctx, claim.ID, ws.ID)
		}
		if err != nil {
			if ws.ID != "" {
				_ = e.Workspaces.EndClaim(e.ctx, ws)
			}
			_ = e.Tasks.Submit(e.ctx, worker.ReportFromText(claim.ID, "Worker workspace could not be created.", loop.Failed, err))
			return
		}
		claim.Workspace, workdir = ws.ID, ws.Directory
		state, err := e.Groups.Get(e.ctx, card.Group)
		if err == nil {
			err = e.setupWorkspace(ctx, p, worker.Assignment{Claim: claim, Session: claim.Session, Scope: event.Scope{Group: card.Group, Task: card.ID}, Workdir: workdir}, ws, state.Group.Settings.Setup)
		}
		if err != nil {
			_ = e.Workspaces.EndClaim(e.ctx, ws)
			if ctx.Err() != nil {
				return
			}
			_ = e.Tasks.Block(e.ctx, card.ID)
			_ = e.Tasks.Submit(e.ctx, task.Report{Claim: claim.ID, Verdict: task.VerdictBlocked, Summary: "MRK-5011"})
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
	run, err := e.StartWorker(ctx, p, worker.Assignment{Claim: claim, Session: claim.Session, Scope: event.Scope{Group: card.Group, Task: card.ID}, Workdir: workdir})
	if err != nil {
		if claim.Workspace != "" {
			if ws, err := e.Workspaces.Get(e.ctx, claim.Workspace); err == nil {
				_ = e.Workspaces.EndClaim(e.ctx, ws)
			}
		}
		_ = e.Tasks.Submit(e.ctx, worker.ReportFromText(claim.ID, "Worker could not start.", loop.Failed, err))
		return
	}
	e.mu.Lock()
	started = true
	delete(e.claimPreparing, claim.ID)
	e.workers.Go(func() {
		defer cancel()
		report, runErr := run.Wait(context.Background())
		defer func() { e.mu.Lock(); delete(e.claimRuns, claim.ID); e.mu.Unlock() }()
		ending, cancel := context.WithTimeout(context.WithoutCancel(e.ctx), 5*time.Second)
		defer cancel()
		if claim.Workspace != "" {
			if ws, err := e.Workspaces.Get(ending, claim.Workspace); err == nil {
				_ = e.Workspaces.EndClaim(ending, ws)
			}
		}
		if runErr != nil && report.Synthesized {
			_ = e.flagFinding(ending, card.Group, leader.Finding{Rule: "claim.exited", Code: "MRK-6002", Claim: claim.ID, Task: card.ID, Member: claim.Member, Session: claim.Session, Action: "interrupt"})
			return
		}
		_ = e.Tasks.Submit(ending, report)
	})
	e.mu.Unlock()
	current, err := e.Tasks.Get(e.ctx, card.ID)
	if err == nil && current.Status == task.Cancelled {
		_ = run.Cancel(e.ctx)
	}
}
func (e *Engine) startLeader(g *groupRun, thread *leader.Thread) {
	state, err := e.Groups.Get(e.ctx, g.group.ID)
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
	e.mu.Lock()
	defer e.mu.Unlock()
	if e.ctx.Err() != nil {
		return
	}
	ctx, cancel := context.WithCancel(e.ctx)
	run := &leaderRun{cancel: cancel, done: make(chan struct{})}
	g.started[thread.Key] = run
	id := thread.Session.ID
	e.groupSessions[id] = true
	e.workers.Go(func() {
		defer func() {
			close(run.done)
			select {
			case g.leaderDone <- completedLeader{thread: thread, run: run}:
			case <-e.ctx.Done():
			}
		}()
		defer cancel()
		defer func() { e.mu.Lock(); delete(e.groupSessions, id); e.mu.Unlock() }()
		e.runLeader(ctx, g, thread)
	})
}

func (e *Engine) runLeader(ctx context.Context, g *groupRun, thread *leader.Thread) {
	ctx, fail := context.WithCancelCause(ctx)
	defer fail(nil)
	defer func() {
		if cause := context.Cause(ctx); cause != nil && !errors.Is(cause, context.Canceled) && !errors.Is(cause, context.DeadlineExceeded) {
			e.pauseLeader(context.WithoutCancel(ctx), g.group.ID, thread)
		}
	}()
	member, err := e.groupMember(ctx, g.group.ID, thread.Leader)
	if err != nil {
		fail(err)
		return
	}
	p, err := e.memberProfile(ctx, member)
	if err != nil {
		fail(err)
		return
	}
	digest := leader.Digest{State: g.state, Focus: thread.Session.Scope.Task}
	thread.Scheduler.SetDigest(digest)
	thread.Scheduler.SetAdmission(func(ctx context.Context) (time.Time, error) {
		state, err := e.Groups.Get(ctx, g.group.ID)
		if err != nil {
			return time.Time{}, err
		}
		if state.IsPaused(thread.Key) {
			return time.Time{}, context.Canceled
		}
		threadMax, groupMax := state.Group.Settings.TurnsPerMinute.Values()
		deadline := g.limits.Take(thread.Key, threadMax, groupMax)
		if deadline.IsZero() {
			return deadline, nil
		}
		return time.Now().Add(deadline.Sub(e.now())), nil
	})
	defer g.limits.Remove(thread.Key)
	var runtime leaderRuntime
	if p.Product != nil {
		runtime, err = e.externalLeaderRuntime(ctx, g, thread, p, fail)
	} else {
		runtime, err = e.builtinLeaderRuntime(ctx, g, thread, p)
	}
	if err != nil {
		fail(err)
		return
	}
	defer runtime.Close()
	initial := len(thread.Session.Messages) == 0
	for {
		batch, err := thread.Scheduler.NextBatch(ctx)
		if err != nil {
			return
		}
		input := digest.Render(batch)
		if initial {
			body, _ := json.Marshal(g.configuration().Brief)
			text := "## Group brief\n" + string(body)
			if thread.Session.Scope.Task != "" {
				card, err := e.Tasks.Get(ctx, thread.Key)
				if err != nil {
					return
				}
				body, _ := json.Marshal(card)
				text += "\n## Task\n" + string(body)
			}
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
	}
}

func (e *Engine) builtinLeaderRuntime(ctx context.Context, g *groupRun, thread *leader.Thread, p profile.Profile) (leaderRuntime, error) {
	saved, loadErr := e.manager.Load(ctx, thread.Session.ID)
	if loadErr != nil && !errors.Is(loadErr, store.ErrNotFound) {
		return nil, loadErr
	}
	var c *conversation
	var err error
	if loadErr == nil {
		c, err = e.conversationFor(saved)
	} else {
		var chosen profile.ModelRef
		if chosen, err = e.memberModel(p.Model); err != nil {
			return nil, err
		}
		c, err = e.newConversation(ctx, SessionOptions{ID: thread.Session.ID, Scope: thread.Session.Scope, Member: thread.Leader, Role: "leader", Mode: p.Mode, Provider: chosen.Provider, Model: chosen.Model, Thinking: chosen.Thinking, Workdir: g.group.Project.Directory, System: p.System, ToolPool: "leader.default", Budget: p.Budget})
	}
	if err != nil {
		return nil, err
	}
	runtime := &builtinLeader{engine: e, conversation: c}
	var final []model.Part
	c.runner.Steer = joinedSteer{thread.Scheduler, c.runner.Steer}
	c.runner.Tools = c.runner.Tools.With(e.leaderTools(g, thread, func(text string) { final = []model.Part{{Text: text}} })...)
	c.state.Tools = c.runner.Tools.Specs()
	c.runner.Finish = func() []model.Part { return final }
	runtime.reset = func() { final = nil }
	if loadErr != nil {
		created, err := e.manager.Create(ctx, *c.state)
		if err != nil {
			runtime.Close()
			return nil, err
		}
		c.state = created
		body, _ := json.Marshal(leader.Handover{Key: thread.Key, Leader: thread.Leader, Session: c.state.ID})
		if _, err := e.Bus.Publish(ctx, event.Event{Stream: event.Stream("group:" + g.group.ID), Scope: c.state.Scope, Type: leader.ThreadStarted, Actor: event.Actor{Kind: event.ActorAgent, ID: thread.Leader}, Payload: body}); err != nil {
			runtime.Close()
			return nil, err
		}
	}
	thread.Session = c.state
	return runtime, nil
}
