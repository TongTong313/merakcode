package sessions

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"slices"
	"sort"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/TongTong313/merakcode/merak/engine/agent/conversation"
	"github.com/TongTong313/merakcode/merak/engine/agent/definition"
	"github.com/TongTong313/merakcode/merak/engine/agent/loop"
	"github.com/TongTong313/merakcode/merak/engine/agent/model"
	"github.com/TongTong313/merakcode/merak/engine/agent/registry"
	"github.com/TongTong313/merakcode/merak/engine/agent/session"
	"github.com/TongTong313/merakcode/merak/engine/agent/tool"
	"github.com/TongTong313/merakcode/merak/engine/collab/group"
	slash "github.com/TongTong313/merakcode/merak/engine/feature/command"
	"github.com/TongTong313/merakcode/merak/engine/feature/plan"
	"github.com/TongTong313/merakcode/merak/engine/feature/schedule"
	"github.com/TongTong313/merakcode/merak/engine/feature/snapshot"
	"github.com/TongTong313/merakcode/merak/engine/infra/errorcode"
	"github.com/TongTong313/merakcode/merak/engine/infra/event"
	"github.com/TongTong313/merakcode/merak/engine/infra/folder"
	"github.com/TongTong313/merakcode/merak/engine/infra/sandbox"
	"github.com/TongTong313/merakcode/merak/engine/infra/store"
)

// StopPlanOfCancelledTurn marks the plan of a conversation as stopped when its turn is cancelled while the plan runs,
// so the person can start it again; a plan that is not running is left as it is.
func (e *Sessions) StopPlanOfCancelledTurn(id event.ID) {
	ctx := context.WithoutCancel(e.core.Ctx)
	if stopped, err := e.plans.Stop(ctx, id); err == nil {
		e.announcePlan(ctx, stopped)
	}
}

// SnapshotRepo is the shadow repository of a session's workspace.
func (e *Sessions) SnapshotRepo(id event.ID, workdir string) (snapshot.Repo, error) {
	return snapshot.Repo{GitDir: filepath.Join(e.snapshotDir, string(id)), Workdir: workdir}, nil
}

func (e *Sessions) trackWorkspace(id event.ID, workdir string) func(context.Context) (string, error) {
	return func(ctx context.Context) (string, error) {
		if !e.SnapshotsEnabled() {
			return "", nil
		}
		repo, err := e.SnapshotRepo(id, workdir)
		if err != nil {
			return "", err
		}
		return repo.Track(ctx)
	}
}

// RevertSession hides a message of the user and everything after it and puts the files that those turns
// changed, whichever tool changed them, back the way they were before the message.
func (e *Sessions) RevertSession(ctx context.Context, id, message event.ID) error {
	e.conversation.WaitIdle(ctx, id)
	c, unlock, err := e.conversation.OpenLocked(ctx, id)
	if err != nil {
		return err
	}
	defer unlock()
	if len(c.Turns) > 0 {
		return errorcode.Coded(errorcode.SessionBusy, errors.New("revert between turns"))
	}
	state := c.State.Read()
	mark, ok := state.MarkOf(message)
	if !ok {
		return errorcode.Coded(errorcode.RevertTargetInvalid, errors.New("not a visible message of this session"))
	}
	revert := session.Revert{Message: message}
	if tree := state.RestoreTree(mark.Index); tree != "" && e.SnapshotsEnabled() {
		repo, err := e.SnapshotRepo(id, state.Config.Workdir)
		if err != nil {
			return err
		}
		if revert.Current, err = repo.Track(ctx); err != nil {
			return err
		}
		if err := repo.Restore(ctx, tree); err != nil {
			return err
		}
		revert.Restored = tree
	}
	if _, err := e.conversation.PublishSession(ctx, c, session.Reverted, revert); err != nil {
		return err
	}
	return e.manager.Snapshot(ctx, c.State)
}

// UnrevertSession brings back what the last revert hid, unless a message was sent since.
func (e *Sessions) UnrevertSession(ctx context.Context, id event.ID) error {
	e.conversation.WaitIdle(ctx, id)
	c, unlock, err := e.conversation.OpenLocked(ctx, id)
	if err != nil {
		return err
	}
	defer unlock()
	if len(c.Turns) > 0 {
		return errorcode.Coded(errorcode.SessionBusy, errors.New("unrevert between turns"))
	}
	state := c.State.Read()
	if state.Hidden == nil {
		return errorcode.Coded(errorcode.NothingToRestore, errors.New("nothing was reverted"))
	}
	if tree := state.Hidden.Current; tree != "" && e.SnapshotsEnabled() {
		repo, err := e.SnapshotRepo(id, state.Config.Workdir)
		if err != nil {
			return err
		}
		if err := repo.Restore(ctx, tree); err != nil {
			return err
		}
	}
	if _, err := e.conversation.PublishSession(ctx, c, session.Unreverted, struct{}{}); err != nil {
		return err
	}
	return e.manager.Snapshot(ctx, c.State)
}

func (e *Sessions) SnapshotsEnabled() bool { return !e.snapshotsOff.Load() }

func (e *Sessions) DeleteConversationSnapshot(_ context.Context, id event.ID) {
	if repo, err := e.SnapshotRepo(id, ""); err == nil {
		_ = os.RemoveAll(repo.GitDir)
	}
}

// PruneSessions deletes the top-level conversations that saw no event for storage.retention_days days and
// returns how many it removed. Nothing is deleted while the setting is 0.
func (e *Sessions) PruneSessions(ctx context.Context) (int, error) {
	days := int(e.retentionDays.Load())
	if days <= 0 {
		return 0, nil
	}
	cutoff := e.core.Now().Add(-time.Duration(days) * 24 * time.Hour)
	recent, err := e.core.Store.Find(ctx, store.Query{After: cutoff})
	if err != nil {
		return 0, err
	}
	active := make(map[event.ID]bool)
	for _, fact := range recent {
		active[fact.Scope.Session] = true
	}
	infos, err := e.manager.List(ctx)
	if err != nil {
		return 0, err
	}
	removed := 0
	for _, info := range infos {
		if info.Config.Parent != "" || info.Config.Member != "" || active[info.ID] || info.CreatedAt.After(cutoff) {
			continue
		}
		if err := e.conversation.DeleteSession(ctx, info.ID); err != nil {
			continue
		}
		removed++
	}
	return removed, nil
}

// PruneDaily removes conversations past their retention once a day, starting shortly after the engine starts.
func (e *Sessions) PruneDaily() {
	timer := time.NewTimer(time.Minute)
	defer timer.Stop()
	for {
		select {
		case <-e.core.Ctx.Done():
			return
		case <-timer.C:
			_, _ = e.PruneSessions(e.core.Ctx)
			timer.Reset(24 * time.Hour)
		}
	}
}

// ConfigureCommands sets the commands of the configuration (the v0.3 command section).
func (e *Sessions) ConfigureCommands(entries map[string]slash.Entry) {
	copied := make(map[string]slash.Entry, len(entries))
	for name, entry := range entries {
		copied[name] = entry
	}
	e.commandSet.Store(&copied)
}

func (e *Sessions) configuredCommands() map[string]slash.Entry {
	if entries := e.commandSet.Load(); entries != nil {
		return *entries
	}
	return nil
}

// CommandList returns the slash commands that apply to a folder: built-in, configured, from files, one for every
// skill and one for every prompt of the MCP servers that answer.
func (e *Sessions) CommandList(ctx context.Context, directory string) ([]slash.Command, error) {
	directory = e.registry.Directory(directory)
	skills, err := e.registry.Skills(directory)
	if err != nil {
		return nil, err
	}
	global := ""
	if roots := e.registry.SkillDirectories(); roots != nil {
		global = roots.Global
	}
	var prompts []slash.MCPPrompt
	for _, prompt := range e.mcpPrompts(ctx, directory) {
		prompts = append(prompts, prompt)
	}
	return slash.List(directory, global, e.configuredCommands(), skills, prompts)
}

// mcpPrompts asks every enabled MCP server for its prompts; a server that does not answer offers none.
func (e *Sessions) mcpPrompts(ctx context.Context, directory string) []slash.MCPPrompt {
	servers := e.registry.MCPDefinitions(ctx, directory)
	launcher := &sandbox.Launcher{Disabled: true}
	launcher.Unavailable = func(context.Context, sandbox.Status) error { return nil }
	env := tool.Env{Workdir: directory, Sandbox: launcher}
	names := make([]string, 0, len(servers))
	for name := range servers {
		names = append(names, name)
	}
	sort.Strings(names)
	found := make([][]slash.MCPPrompt, len(names))
	var wait sync.WaitGroup
	for i, name := range names {
		if servers[name].Disabled {
			continue
		}
		wait.Add(1)
		go func() {
			defer wait.Done()
			process, err := e.registry.StartMCP(ctx, name, servers[name], env)
			if err != nil {
				return
			}
			defer process.Close()
			prompts, err := process.Prompts(ctx)
			if err != nil {
				return
			}
			for _, prompt := range prompts {
				entry := slash.MCPPrompt{Server: name, Name: prompt.Name, Description: prompt.Description}
				for _, argument := range prompt.Arguments {
					entry.Arguments = append(entry.Arguments, argument.Name)
				}
				found[i] = append(found[i], entry)
			}
		}()
	}
	wait.Wait()
	var all []slash.MCPPrompt
	for _, prompts := range found {
		all = append(all, prompts...)
	}
	return all
}

// RunCommand runs a slash command in a conversation: it expands the template with the user's words and sends the
// result as the next message. /context is answered by the engine and sends nothing.
func (e *Sessions) RunCommand(ctx context.Context, id event.ID, name, arguments string) (slash.Result, error) {
	state, err := e.conversation.SessionSnapshot(ctx, id)
	if err != nil {
		return slash.Result{}, err
	}
	list, err := e.CommandList(ctx, state.Config.Workdir)
	if err != nil {
		return slash.Result{}, err
	}
	index := slices.IndexFunc(list, func(c slash.Command) bool { return c.Name == name })
	if index < 0 {
		return slash.Result{}, errorcode.Coded(errorcode.SessionRequestFailed, errors.New("no such command"))
	}
	found := list[index]
	if found.Local {
		return slash.Result{Text: e.conversation.ContextReport(state)}, nil
	}
	text := found.Expand(arguments)
	if found.Source == slash.MCP {
		if text, err = e.expandPrompt(ctx, state.Config.Workdir, found, arguments); err != nil {
			return slash.Result{}, errorcode.Coded(errorcode.McpStartFailed, err)
		}
	}
	if strings.TrimSpace(text) == "" {
		return slash.Result{}, errorcode.Coded(errorcode.SessionRequestFailed, errors.New("the command has nothing to send"))
	}
	var selection []session.Selection
	if found.Model != "" {
		provider, model, _ := strings.Cut(found.Model, "/")
		selection = append(selection, session.Selection{Provider: provider, Model: model})
	}
	e.conversation.MarkFromCommand(ctx, id)
	if err := e.conversation.Send(ctx, id, []model.Part{{Text: text}}, selection...); err != nil {
		return slash.Result{}, err
	}
	return slash.Result{Sent: true}, nil
}

func (e *Sessions) expandPrompt(ctx context.Context, directory string, found slash.Command, arguments string) (string, error) {
	servers := e.registry.MCPDefinitions(ctx, directory)
	definition, ok := servers[found.Server]
	if !ok || definition.Disabled {
		return "", errors.New("the MCP server of this command is not available")
	}
	launcher := &sandbox.Launcher{Disabled: true}
	launcher.Unavailable = func(context.Context, sandbox.Status) error { return nil }
	process, err := e.registry.StartMCP(ctx, found.Server, definition, tool.Env{Workdir: directory, Sandbox: launcher})
	if err != nil {
		return "", err
	}
	defer process.Close()
	values := map[string]string{}
	if len(found.Arguments) > 0 {
		values[found.Arguments[0]] = strings.TrimSpace(arguments)
	}
	return process.GetPrompt(ctx, found.Prompt, values)
}

// planRoot finds the conversation a plan belongs to: a child reads the plan of its parent.
func (e *Sessions) planRoot(ctx context.Context, id event.ID) (event.ID, error) {
	for range 8 {
		state, err := e.conversation.SessionSnapshot(ctx, id)
		if err != nil {
			return "", err
		}
		if state.Config.Parent == "" {
			return id, nil
		}
		id = state.Config.Parent
	}
	return "", errors.New("the conversation has no root")
}

func planError(err error) error {
	switch {
	case errors.Is(err, plan.ErrStale):
		return errorcode.Coded(errorcode.PlanStale, err)
	case errors.Is(err, plan.ErrState):
		return errorcode.Coded(errorcode.PlanState, err)
	}
	return err
}

func (e *Sessions) announcePlan(ctx context.Context, value plan.Plan) {
	body, err := json.Marshal(value)
	if err != nil {
		return
	}
	_, _ = e.core.Bus.Publish(ctx, event.Event{Stream: event.Stream("session:" + value.Session), Scope: event.Scope{Session: value.Session}, Type: plan.Updated, Actor: event.Actor{Kind: event.ActorAgent}, Payload: body})
}

func (e *Sessions) writePlan(ctx context.Context, id event.ID, content string) (plan.Plan, error) {
	written, err := e.plans.Write(ctx, id, content)
	if err == nil {
		e.announcePlan(ctx, written)
	}
	return written, planError(err)
}

// GetPlan returns the plan of a conversation; a child gets the plan of its parent.
func (e *Sessions) GetPlan(ctx context.Context, id event.ID) (plan.Plan, error) {
	root, err := e.planRoot(ctx, id)
	if err != nil {
		return plan.Plan{}, err
	}
	value, err := e.plans.Get(ctx, root)
	return value, planError(err)
}

// SavePlan stores an edit of the plan; the revision is the one the editor started from.
func (e *Sessions) SavePlan(ctx context.Context, id event.ID, content string, revision int) (plan.Plan, error) {
	root, err := e.planRoot(ctx, id)
	if err != nil {
		return plan.Plan{}, err
	}
	saved, err := e.plans.Save(ctx, root, content, revision)
	if err == nil {
		e.announcePlan(ctx, saved)
	}
	return saved, planError(err)
}

// ExecutePlan fixes the current plan as the snapshot to run and sends the execution message.
func (e *Sessions) ExecutePlan(ctx context.Context, id event.ID) (plan.Plan, error) {
	root, err := e.planRoot(ctx, id)
	if err != nil {
		return plan.Plan{}, err
	}
	run, err := e.plans.Execute(ctx, root)
	if err != nil {
		return plan.Plan{}, planError(err)
	}
	e.announcePlan(ctx, run.Plan)
	message := "Execute this plan now. Keep your todo list with todo_write, one item per step, and mark each step done as you finish it.\n\n" + run.Snapshot
	if err := e.conversation.Send(ctx, root, []model.Part{{Text: message}}); err != nil {
		return run.Plan, err
	}
	return run.Plan, nil
}

// StopPlan marks a running plan as stopped and stops the conversation's current turn.
func (e *Sessions) StopPlan(ctx context.Context, id event.ID) (plan.Plan, error) {
	root, err := e.planRoot(ctx, id)
	if err != nil {
		return plan.Plan{}, err
	}
	stopped, err := e.plans.Stop(ctx, root)
	if err != nil {
		return plan.Plan{}, planError(err)
	}
	e.announcePlan(ctx, stopped)
	_ = e.conversation.Cancel(root)
	return stopped, nil
}

// SendPlanned sends a message that first asks for a plan: the agent writes it with write_plan and stops.
func (e *Sessions) SendPlanned(ctx context.Context, id event.ID, parts []model.Part, selections ...session.Selection) error {
	ask := model.Part{Text: "Before you do anything else, write a plan for the request below by calling write_plan with a Markdown plan, then stop. You may read files to make the plan, but do not change any file and do not run any command that changes anything. The person will review the plan first."}
	return e.conversation.Send(ctx, id, append([]model.Part{ask}, parts...), selections...)
}

// todosChanged finishes the plan of a conversation when the model marked every step done.
func (e *Sessions) todosChanged(ctx context.Context, id event.ID, items []tool.Todo) {
	if len(items) == 0 {
		return
	}
	for _, item := range items {
		if item.Status != "done" {
			return
		}
	}
	finished, err := e.plans.Finish(context.WithoutCancel(ctx), id)
	if err == nil {
		e.announcePlan(context.WithoutCancel(ctx), finished)
	}
}

// ---- scheduled tasks ----

// CreateSchedule stores a scheduled task that starts a conversation in a folder each time the cron expression
// names. The agent, when given, is a name or an id from the agent library.
func (e *Sessions) CreateSchedule(ctx context.Context, cron, prompt, agentName, workdir string) (schedule.Schedule, error) {
	workdir = e.registry.Directory(workdir)
	if err := folder.Existing(workdir); err != nil {
		return schedule.Schedule{}, errorcode.Coded(errorcode.WorkspaceInvalid, err)
	}
	if agentName != "" {
		if _, found := e.findAgent(ctx, e.conversation.LocalHuman(), agentName, workdir); !found {
			return schedule.Schedule{}, errorcode.Coded(errorcode.ScheduleInvalid, fmt.Errorf("no agent is named %s", agentName))
		}
	}
	created, err := e.schedules.Create(ctx, schedule.Schedule{ID: e.core.NewID(), Cron: cron, Prompt: prompt, Agent: agentName, Workdir: workdir, Owner: e.conversation.LocalHuman(), Created: e.core.Now()})
	if err != nil {
		return schedule.Schedule{}, errorcode.Coded(errorcode.ScheduleInvalid, err)
	}
	if spec, err := schedule.Parse(created.Cron); err == nil {
		created.Next = spec.Next(e.core.Now())
	}
	return created, nil
}

// ListSchedules returns every scheduled task, oldest first, each with its next run.
func (e *Sessions) ListSchedules(ctx context.Context) ([]schedule.Schedule, error) {
	return e.schedules.List(ctx, e.core.Now())
}

// DeleteSchedule removes a scheduled task; it never runs again.
func (e *Sessions) DeleteSchedule(ctx context.Context, id event.ID) error {
	if err := e.schedules.Delete(ctx, id); err != nil {
		if errors.Is(err, schedule.ErrNotFound) {
			return errorcode.Coded(errorcode.ScheduleUnknown, err)
		}
		return err
	}
	return nil
}

// CheckSchedules starts the scheduled tasks that became due since the last check. The engine calls it every minute;
// it is public so that a test with its own clock can call it.
func (e *Sessions) CheckSchedules(ctx context.Context) error {
	return e.scheduleRunner.Check(ctx)
}

func (e *Sessions) watchSchedules(every time.Duration) {
	if every <= 0 {
		every = time.Minute
	}
	if err := e.scheduleRunner.Open(e.core.Ctx); err != nil && e.core.Ctx.Err() == nil && e.core.Logger != nil {
		e.core.Logger.Warn("scheduled tasks could not be read")
	}
	ticker := time.NewTicker(every)
	defer ticker.Stop()
	for {
		select {
		case <-e.core.Ctx.Done():
			return
		case <-ticker.C:
			if err := e.CheckSchedules(e.core.Ctx); err != nil && e.core.Ctx.Err() == nil && e.core.Logger != nil {
				e.core.Logger.Warn("scheduled tasks could not be checked")
			}
		}
	}
}

func (e *Sessions) fireSchedule(_ context.Context, s schedule.Schedule) {
	e.core.Workers.Go(func() { e.runSchedule(e.core.Ctx, s) })
}

func (e *Sessions) missedSchedule(ctx context.Context, s schedule.Schedule, count int) {
	e.noticeSchedule(ctx, s, "", "schedule-missed", s.Title(), count)
}

// runSchedule starts the conversation of one due run, sends it the prompt and tells the owner how it ended.
func (e *Sessions) runSchedule(ctx context.Context, s schedule.Schedule) {
	fail := func(code string) { e.noticeSchedule(ctx, s, "", "blocked", code, 0) }
	options := conversation.SessionOptions{Workdir: s.Workdir, Switches: map[string]bool{"schedule_create": false}}
	if s.Agent != "" {
		chosen, found := e.findAgent(ctx, s.Owner, s.Agent, s.Workdir)
		if !found {
			fail(errorcode.ScheduleRunFailed)
			return
		}
		if chosen.Source != "" || strings.HasPrefix(string(chosen.ID), "builtin-") {
			conversation.UseAgent(&options, chosen)
		} else {
			options.Agent = chosen.ID
		}
	}
	id, err := e.conversation.CreateSession(ctx, options)
	if err != nil {
		fail(errorcode.ScheduleRunFailed)
		return
	}
	title := s.Title()
	if err := e.conversation.UpdateSession(ctx, id, session.Update{Title: &title}); err != nil {
		fail(errorcode.ScheduleRunFailed)
		return
	}
	finished, stop := e.core.Bus.Subscribe(event.Filter{Scope: event.Scope{Session: id}, Types: []event.Type{loop.TurnFinished}})
	defer stop()
	if err := e.conversation.Send(ctx, id, []model.Part{{Text: s.Prompt}}); err != nil {
		fail(errorcode.ScheduleRunFailed)
		return
	}
	select {
	case fact := <-finished:
		outcome, err := event.Decode[loop.Outcome](fact)
		if err == nil && outcome.Stop == loop.Failed {
			e.noticeSchedule(ctx, s, id, "blocked", outcome.Code, 0)
			return
		}
		e.noticeSchedule(ctx, s, id, "schedule", title, 0)
	case <-ctx.Done():
	}
}

// noticeSchedule puts a notice about a scheduled task into the inbox of its owner.
func (e *Sessions) noticeSchedule(ctx context.Context, s schedule.Schedule, conversation event.ID, kind, text string, count int) {
	body, err := json.Marshal(group.Notice{Kind: kind, Text: text, To: []event.ID{s.Owner}, Count: count})
	if err != nil {
		return
	}
	stream := event.Stream("inbox:" + s.Owner)
	e.scheduleNoticeMu.Lock()
	defer e.scheduleNoticeMu.Unlock()
	if err := store.ResumeStream(ctx, e.core.Bus, e.core.Store, stream); err != nil {
		return
	}
	_, _ = e.core.Bus.Publish(ctx, event.Event{Stream: stream, Scope: event.Scope{Session: conversation}, Type: group.NoticeSent, Actor: event.Actor{Kind: event.ActorAgent}, Payload: body})
}

// findAgent finds an agent of the library, of a file or of the configuration by name or id.
func (e *Sessions) findAgent(ctx context.Context, human event.ID, name, directory string) (definition.Agent, bool) {
	listed, err := e.registry.ListAgentsFor(ctx, human, directory)
	if err != nil {
		return definition.Agent{}, false
	}
	for _, candidate := range listed {
		if candidate.Name == name || string(candidate.ID) == name {
			return candidate, true
		}
	}
	return definition.Agent{}, false
}

// sessionScheduler lets the schedule tools of one conversation act on the schedules of its folder.
type sessionScheduler struct {
	e       *Sessions
	workdir string
}

func scheduleInfo(s schedule.Schedule) tool.ScheduleInfo {
	info := tool.ScheduleInfo{ID: string(s.ID), Cron: s.Cron, Prompt: s.Prompt, Agent: s.Agent}
	if !s.Next.IsZero() {
		info.Next = s.Next.Format(time.RFC3339)
	}
	return info
}

func (s sessionScheduler) Create(ctx context.Context, cron, prompt, agentName string) (tool.ScheduleInfo, error) {
	created, err := s.e.CreateSchedule(ctx, cron, prompt, agentName, s.workdir)
	if err != nil {
		return tool.ScheduleInfo{}, err
	}
	return scheduleInfo(created), nil
}

func (s sessionScheduler) List(ctx context.Context) ([]tool.ScheduleInfo, error) {
	listed, err := s.e.ListSchedules(ctx)
	if err != nil {
		return nil, err
	}
	var infos []tool.ScheduleInfo
	for _, item := range listed {
		if item.Workdir == s.e.registry.Directory(s.workdir) {
			infos = append(infos, scheduleInfo(item))
		}
	}
	return infos, nil
}

func (s sessionScheduler) Delete(ctx context.Context, id string) error {
	found, err := s.e.schedules.Get(ctx, event.ID(id))
	if err != nil || found.Workdir != s.e.registry.Directory(s.workdir) {
		return errors.New("no scheduled task of this folder has that id")
	}
	return s.e.DeleteSchedule(ctx, found.ID)
}

func (e *Sessions) ConversationPlanTools(stage conversation.LoopStage, state *session.State, runner *loop.Loop) {
	if stage != conversation.LoopTools {
		return
	}
	if state.Config.Parent == "" && state.Config.ToolPool != "leader.default" {
		planned := new(atomic.Bool)
		runner.Tools = runner.Tools.With(tool.WritePlan{Write: func(ctx context.Context, content string) error {
			if _, err := e.writePlan(ctx, state.ID, content); err != nil {
				return err
			}
			planned.Store(true)
			return nil
		}})
		runner.Finish = func() []model.Part {
			if planned.CompareAndSwap(true, false) {
				return []model.Part{{Text: "The plan is ready for review."}}
			}
			return nil
		}
		runner.OnTodos = func(ctx context.Context, items []tool.Todo) { e.todosChanged(ctx, state.ID, items) }
	}
}

func (e *Sessions) ConversationScheduleTools(stage conversation.LoopStage, state *session.State, runner *loop.Loop) {
	if stage != conversation.LoopTools {
		return
	}
	if state.Config.Parent == "" && state.Scope.Group == "" {
		scheduler := sessionScheduler{e: e, workdir: state.Config.Workdir}
		for _, t := range []tool.Tool{tool.ScheduleCreate{Scheduler: scheduler}, tool.ScheduleList{Scheduler: scheduler}, tool.ScheduleDelete{Scheduler: scheduler}} {
			readOnly := state.Config.ToolPool == "worker.readonly" || e.tools.Name == "worker.readonly"
			if name := t.Spec().Name; e.registry.ToolEnabled(name) && registry.SwitchedOn(state.Config.Switches, name) && (!readOnly || t.Spec().Effect == tool.EffectRead) {
				runner.Tools = runner.Tools.With(e.gate.Wrap(t))
			}
		}
	}
}

func (e *Sessions) ConversationTracking(stage conversation.LoopStage, state *session.State, runner *loop.Loop) {
	if stage != conversation.LoopTrack {
		return
	}
	runner.Track = e.trackWorkspace(state.ID, state.Config.Workdir)
}

func (e *Sessions) ConversationInput(_ context.Context, c *conversation.Conversation, input loop.Input, parts []model.Part, expanded bool) ([]model.Part, error) {
	if c.Recommender != nil && !expanded && input.Actor.Kind == event.ActorHuman && input.Child == nil {
		var typed strings.Builder
		for _, part := range input.Parts {
			typed.WriteString(part.Text + "\n")
		}
		if suggestion := c.Recommender.For(typed.String()); suggestion != "" {
			parts = append(parts, model.Part{Text: suggestion})
		}
	}
	return parts, nil
}

func (e *Sessions) ConversationCheckpoint(ctx context.Context, c *conversation.Conversation, _ event.ID, stage conversation.EndStage) error {
	if stage == conversation.Snapshot {
		return e.manager.Snapshot(ctx, c.State)
	}
	return nil
}

func (e *Sessions) SetSnapshots(enabled bool) { e.snapshotsOff.Store(!enabled) }

func (e *Sessions) SetRetentionDays(days int) { e.retentionDays.Store(int64(days)) }
