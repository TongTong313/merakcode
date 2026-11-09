package engine

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"os"
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
	"github.com/TongTong313/merakcode/merak/internal/platform/git"
)

type groupRun struct {
	triggers     *leader.Triggers
	group        group.Group
	state        *leader.State
	threads      *leader.Threads
	started      map[event.ID]*leaderRun
	handovers    map[event.ID]*pendingHandover
	handoverDone chan completedHandover
	seq          uint64
}

type leaderRun struct {
	cancel context.CancelFunc
	done   chan struct{}
}

func (e *Engine) CreateGroup(ctx context.Context, g group.Group, members []group.Member, profiles []profile.Profile) (group.Group, error) {
	if _, err := leader.NewTriggers(append(leader.DefaultTriggers(), g.Settings.Triggers...)); err != nil {
		return group.Group{}, err
	}
	if g.Kind != group.KindLocal {
		return group.Group{}, errors.New("only local groups are supported")
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
			return group.Group{}, errors.New("a target branch is required for a detached repository")
		}
		if _, err := git.Commit(ctx, g.Project.Directory, "refs/heads/"+g.Brief.TargetBranch); err != nil {
			return group.Group{}, err
		}
	} else if g.Brief.TargetBranch != "" {
		return group.Group{}, errors.New("a target branch requires a repository root project")
	}
	for _, p := range profiles {
		if err := e.saveGroupProfile(ctx, p); err != nil {
			return group.Group{}, err
		}
	}
	members = append([]group.Member(nil), members...)
	for i, member := range members {
		if member.Kind != group.MemberAgent {
			continue
		}
		p, err := e.memberProfile(ctx, member)
		if err != nil {
			return group.Group{}, err
		}
		if string(p.Role) != string(member.AgentRole) {
			return group.Group{}, errors.New("member role must match its profile")
		}
		if member.AgentRole == group.AgentLeader && p.Product != nil {
			return group.Group{}, errors.New("external leaders are not supported")
		}
		members[i].Hosts = append([]string(nil), p.Network...)
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
func (e *Engine) saveGroupProfile(ctx context.Context, p profile.Profile) error {
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
	return e.store.Put(ctx, store.Doc{Kind: "profile", Key: string(p.ID), Body: body})
}
func (e *Engine) AddGroupMember(ctx context.Context, id event.ID, member group.Member, p *profile.Profile) (group.Member, error) {
	return e.addGroupMember(ctx, id, member, p, true)
}

func (e *Engine) addGroupMember(ctx context.Context, id event.ID, member group.Member, p *profile.Profile, acceptNetwork bool) (group.Member, error) {
	member.Hosts = nil
	if p != nil {
		if string(p.Role) != string(member.AgentRole) {
			return group.Member{}, errors.New("member role must match its profile")
		}
		if err := e.saveGroupProfile(ctx, *p); err != nil {
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
			return group.Member{}, errors.New("member role must match its profile")
		}
		if acceptNetwork {
			member.Hosts = append([]string(nil), configured.Network...)
		}
	}
	return e.Groups.AddMember(ctx, id, member)
}
func (e *Engine) memberProfile(ctx context.Context, member group.Member) (profile.Profile, error) {
	for _, p := range defaultProfiles() {
		if p.ID == member.Profile {
			return p, nil
		}
	}
	doc, err := e.store.Fetch(ctx, "profile", string(member.Profile))
	if err != nil {
		return profile.Profile{}, err
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
	if human.Kind != group.MemberHuman || card.CreatedBy.Kind != event.ActorHuman || memberID == "" {
		return task.Card{}, errors.New("direct assignment requires a human creator and a worker")
	}
	return e.createTask(ctx, card, memberID)
}

func (e *Engine) createTask(ctx context.Context, card task.Card, memberID event.ID) (task.Card, error) {
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
	run := &groupRun{group: g, state: new(leader.State), started: map[event.ID]*leaderRun{}, handovers: map[event.ID]*pendingHandover{}, handoverDone: make(chan completedHandover, 16)}
	run.triggers = triggers
	run.threads = leader.NewThreads(g, run.state, e.newID)
	updates := map[event.ID]event.Event{}
	for {
		history, err := e.store.Read(ctx, event.Stream("group:"+g.ID), run.seq+1, 128)
		if err != nil {
			stop()
			return err
		}
		for _, fact := range history {
			if fact.Type == task.Updated {
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
		for id, fact := range updates {
			card, err := e.Tasks.Get(e.ctx, id)
			if err != nil || card.Parent != "" || card.Phase == task.PhaseDone || card.Phase == task.PhaseCancelled {
				continue
			}
			thread := run.threads.Route(fact)
			if thread != nil && thread.Leader != card.Leader {
				e.beginHandOver(run, thread, fact)
			}
		}
		for {
			select {
			case <-e.ctx.Done():
				return
			case result := <-run.handoverDone:
				_ = e.finishHandOver(e.ctx, run, result)
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
					run.group.Settings = updated.Settings
				}
				if err := run.state.Apply(fact); err != nil {
					continue
				}
				if err := e.saveGroupState(e.ctx, run); err != nil {
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
				if fact.Type == task.Reported || fact.Type == task.Reviewed {
					card, err := event.Decode[task.Card](fact)
					if err == nil {
						for _, claim := range card.Claims {
							e.startMember(run, claim.Member)
						}
					}
				}
				if fact.Type == task.Closed {
					card, err := event.Decode[task.Card](fact)
					if err == nil && card.Status == task.Cancelled {
						if card.Parent == "" && run.started[card.ID] != nil {
							run.started[card.ID].cancel()
						}
						for _, claim := range card.Claims {
							e.mu.Lock()
							running, ok := e.claimRuns[claim.ID]
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
				if environmental(fact) && run.group.Settings.Initiative == group.Passive {
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
				if fact.Type != task.Progressed && fact.Type != group.MemberAsked && fact.Type != question.Answered && fact.Type != task.Opened && fact.Type != task.Reported && fact.Type != workspace.MergeDone && fact.Type != workspace.MergeConflicted && fact.Type != group.HumanSaid && fact.Type != task.Reviewed {
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
	memberID := claim.Member
	card, err := e.Tasks.Get(e.ctx, claim.Task)
	if err != nil {
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
	if g.group.Brief.Check != "" {
		p.System += "\nRun the group's check command before submitting your report: " + g.group.Brief.Check
	}
	if card.Workspace != "" {
		var ws workspace.Workspace
		var err error
		ws, err = e.Workspaces.ForClaim(e.ctx, workdir, claim, card)
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
		if card.Workspace == workspace.KindWorktree {
			p.System += "\nYou work in an isolated Git worktree. Stay within the task areas and your claim scope. Verify your changes and commit them on the assigned branch before submitting your report. Do not merge into or switch the target branch."
		} else if card.Workspace == workspace.KindFolder {
			p.System += "\nYou work in an isolated folder containing only the task's declared input files. Write outputs here and declare their relative paths in the report's artifacts. Do not copy results into the original project."
		} else if card.Workspace == workspace.KindNone {
			p.ToolPool = "worker.readonly"
			p.System += "\nThis is a research task. File access is read-only. Return your findings in the report."
		}
	}
	type discussionMessage struct {
		ID    event.ID    `json:"id"`
		Actor event.Actor `json:"actor"`
		Text  string      `json:"text"`
	}
	var discussion []discussionMessage
	for _, id := range card.Discussion {
		fact, err := e.store.Get(e.ctx, id)
		if err != nil {
			continue
		}
		message, err := event.Decode[group.Message](fact)
		if err == nil {
			discussion = append(discussion, discussionMessage{ID: id, Actor: fact.Actor, Text: message.Text})
		}
	}
	packet, _ := json.Marshal(struct {
		Task       task.Card           `json:"task"`
		Claim      task.Claim          `json:"claim"`
		Discussion []discussionMessage `json:"discussion,omitempty"`
	}{card, claim, discussion})
	run, err := e.StartWorker(e.ctx, p, worker.Assignment{Claim: claim, Session: claim.Session, Scope: event.Scope{Group: card.Group, Task: card.ID}, Workdir: workdir, Packet: string(packet)})
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
	e.claimRuns[claim.ID] = claimRun{run: run, caps: e.runnerFor(p, nil).Caps()}
	e.workers.Go(func() {
		report, _ := run.Wait(context.Background())
		e.mu.Lock()
		delete(e.claimRuns, claim.ID)
		e.mu.Unlock()
		ending, cancel := context.WithTimeout(context.WithoutCancel(e.ctx), 5*time.Second)
		defer cancel()
		if claim.Workspace != "" {
			if ws, err := e.Workspaces.Get(ending, claim.Workspace); err == nil {
				_ = e.Workspaces.EndClaim(ending, ws)
			}
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
	if g.started[thread.Key] != nil || g.handovers[thread.Key] != nil {
		return
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
		defer close(run.done)
		defer cancel()
		defer func() { e.mu.Lock(); delete(e.groupSessions, id); e.mu.Unlock() }()
		e.runLeader(ctx, g, thread)
	})
}

func (e *Engine) runLeader(ctx context.Context, g *groupRun, thread *leader.Thread) {
	member, err := e.groupMember(ctx, g.group.ID, thread.Leader)
	if err != nil {
		return
	}
	p, err := e.memberProfile(ctx, member)
	if err != nil {
		return
	}
	saved, loadErr := e.manager.Load(ctx, thread.Session.ID)
	if loadErr != nil && !errors.Is(loadErr, store.ErrNotFound) {
		return
	}
	var c *conversation
	if loadErr == nil {
		c, err = e.conversationFor(saved)
	} else {
		c, err = e.newConversation(ctx, SessionOptions{ID: thread.Session.ID, Scope: thread.Session.Scope, Member: thread.Leader, Role: "leader", Provider: p.Model.Provider, Model: p.Model.Model, Thinking: p.Model.Thinking, Workdir: g.group.Project.Directory, System: p.System, ToolPool: "leader.default"})
	}
	if err != nil {
		return
	}
	defer e.releaseSandbox(c.state.ID)
	defer c.runner.Env.Jobs.Close()
	if c.children != nil {
		defer c.children.Close()
	}
	var final []model.Part
	digest := leader.Digest{State: g.state, Focus: c.state.Scope.Task}
	thread.Scheduler.SetDigest(digest)
	c.runner.Steer = joinedSteer{thread.Scheduler, c.runner.Steer}
	c.runner.Tools = c.runner.Tools.With(e.leaderTools(g, thread, func(text string) { final = []model.Part{{Text: text}} })...)
	c.state.Tools = c.runner.Tools.Specs()
	c.runner.Finish = func() []model.Part { return final }
	if loadErr != nil {
		c.state, err = e.manager.Create(ctx, *c.state)
		if err != nil {
			return
		}
		body, _ := json.Marshal(leader.Handover{Key: thread.Key, Leader: thread.Leader, Session: c.state.ID})
		if _, err := e.Bus.Publish(ctx, event.Event{Stream: event.Stream("group:" + g.group.ID), Scope: c.state.Scope, Type: leader.ThreadStarted, Actor: event.Actor{Kind: event.ActorAgent, ID: thread.Leader}, Payload: body}); err != nil {
			return
		}
	}
	thread.Session = c.state
	initial := thread.Handover
	if len(c.state.Messages) > 0 {
		initial = ""
	}
	for {
		batch, err := thread.Scheduler.NextBatch(ctx)
		if err != nil {
			return
		}
		final = nil
		input := digest.Render(batch)
		if initial != "" {
			card, err := e.Tasks.Get(ctx, thread.Key)
			if err != nil {
				return
			}
			body, _ := json.Marshal(card)
			input.Parts = append([]model.Part{{Text: "## Handover\n" + initial + "\n## Task\n" + string(body)}}, input.Parts...)
			initial = ""
		}
		_, _ = e.runInput(ctx, c, input)
	}
}
