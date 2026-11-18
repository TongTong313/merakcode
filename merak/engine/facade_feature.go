package engine

import (
	"context"
	"time"

	"github.com/TongTong313/merakcode/merak/engine/agent/definition"
	"github.com/TongTong313/merakcode/merak/engine/agent/mcp"
	"github.com/TongTong313/merakcode/merak/engine/agent/memory"
	"github.com/TongTong313/merakcode/merak/engine/agent/model"
	"github.com/TongTong313/merakcode/merak/engine/agent/rules"
	"github.com/TongTong313/merakcode/merak/engine/agent/session"
	"github.com/TongTong313/merakcode/merak/engine/agent/skill"
	"github.com/TongTong313/merakcode/merak/engine/collab/group"
	adminrules "github.com/TongTong313/merakcode/merak/engine/feature/admin/rules"
	adminskill "github.com/TongTong313/merakcode/merak/engine/feature/admin/skill"
	"github.com/TongTong313/merakcode/merak/engine/feature/code"
	slash "github.com/TongTong313/merakcode/merak/engine/feature/command"
	"github.com/TongTong313/merakcode/merak/engine/feature/plan"
	"github.com/TongTong313/merakcode/merak/engine/feature/project"
	"github.com/TongTong313/merakcode/merak/engine/feature/review"
	"github.com/TongTong313/merakcode/merak/engine/feature/schedule"
	"github.com/TongTong313/merakcode/merak/engine/feature/terminal"
	"github.com/TongTong313/merakcode/merak/engine/infra/event"
	"github.com/TongTong313/merakcode/merak/engine/infra/git"
	"github.com/TongTong313/merakcode/merak/engine/infra/store"
)

func (e *Engine) RevertSession(ctx context.Context, id, message event.ID) error {
	return e.sessions.RevertSession(ctx, id, message)
}

func (e *Engine) UnrevertSession(ctx context.Context, id event.ID) error {
	return e.sessions.UnrevertSession(ctx, id)
}

func (e *Engine) PruneSessions(ctx context.Context) (int, error) {
	return e.sessions.PruneSessions(ctx)
}

func (e *Engine) ConfigureCommands(entries map[string]slash.Entry) {
	e.sessions.ConfigureCommands(entries)
}

func (e *Engine) CommandList(ctx context.Context, directory string) ([]slash.Command, error) {
	return e.sessions.CommandList(ctx, directory)
}

func (e *Engine) RunCommand(ctx context.Context, id event.ID, name, arguments string) (slash.Result, error) {
	return e.sessions.RunCommand(ctx, id, name, arguments)
}

func (e *Engine) GetPlan(ctx context.Context, id event.ID) (plan.Plan, error) {
	return e.sessions.GetPlan(ctx, id)
}

func (e *Engine) SavePlan(ctx context.Context, id event.ID, content string, revision int) (plan.Plan, error) {
	return e.sessions.SavePlan(ctx, id, content, revision)
}

func (e *Engine) ExecutePlan(ctx context.Context, id event.ID) (plan.Plan, error) {
	return e.sessions.ExecutePlan(ctx, id)
}

func (e *Engine) StopPlan(ctx context.Context, id event.ID) (plan.Plan, error) {
	return e.sessions.StopPlan(ctx, id)
}

func (e *Engine) SendPlanned(ctx context.Context, id event.ID, parts []model.Part, selections ...session.Selection) error {
	return e.sessions.SendPlanned(ctx, id, parts, selections...)
}

func (e *Engine) CreateSchedule(ctx context.Context, cron, prompt, agentName, workdir string) (schedule.Schedule, error) {
	return e.sessions.CreateSchedule(ctx, cron, prompt, agentName, workdir)
}

func (e *Engine) ListSchedules(ctx context.Context) ([]schedule.Schedule, error) {
	return e.sessions.ListSchedules(ctx)
}

func (e *Engine) DeleteSchedule(ctx context.Context, id event.ID) error {
	return e.sessions.DeleteSchedule(ctx, id)
}

func (e *Engine) CheckSchedules(ctx context.Context) error { return e.sessions.CheckSchedules(ctx) }

func (e *Engine) FindEvents(ctx context.Context, q store.Query) ([]event.Event, error) {
	return e.sessions.FindEvents(ctx, q)
}

func (e *Engine) ExportSession(ctx context.Context, id event.ID) ([]event.Event, error) {
	return e.sessions.ExportSession(ctx, id)
}

func (e *Engine) ImportSession(ctx context.Context, facts []event.Event) (event.ID, error) {
	return e.sessions.ImportSession(ctx, facts)
}

func (e *Engine) ImportConversation(ctx context.Context, facts []event.Event) (event.ID, error) {
	return e.sessions.ImportConversation(ctx, facts)
}

func (e *Engine) ImportPlan(ctx context.Context, id event.ID, content string, status plan.Status) (plan.Plan, error) {
	return e.sessions.ImportPlan(ctx, id, content, status)
}

func (e *Engine) ImportNote(ctx context.Context, note memory.Note) (memory.Note, error) {
	return e.sessions.ImportNote(ctx, note)
}

func (e *Engine) Notify(ctx context.Context, human event.ID, notice group.Notice) error {
	return e.sessions.Notify(ctx, human, notice)
}

func (e *Engine) ReadImport(ctx context.Context, key string) ([]byte, uint64, error) {
	return e.sessions.ReadImport(ctx, key)
}

func (e *Engine) WriteImport(ctx context.Context, key string, body []byte, rev uint64) error {
	return e.sessions.WriteImport(ctx, key, body, rev)
}

func (e *Engine) ListFiles(ctx context.Context, directory, path string) ([]project.FileNode, error) {
	return e.project.ListFiles(ctx, directory, path)
}

func (e *Engine) RepoStatus(ctx context.Context, directory string) (git.State, error) {
	return e.project.RepoStatus(ctx, directory)
}

func (e *Engine) RepoBranches(ctx context.Context, directory string) ([]git.Branch, error) {
	return e.project.RepoBranches(ctx, directory)
}

func (e *Engine) RepoCheckout(ctx context.Context, directory, branch string) error {
	return e.project.RepoCheckout(ctx, directory, branch)
}

func (e *Engine) RepoDiff(ctx context.Context, directory, base string, sessionID, message event.ID) ([]git.Change, error) {
	return e.project.RepoDiff(ctx, directory, base, sessionID, message)
}

func (e *Engine) RepoCommit(ctx context.Context, directory, message string, paths []string) (string, error) {
	return e.project.RepoCommit(ctx, directory, message, paths)
}

func (e *Engine) RepoStage(ctx context.Context, directory string, paths []string) error {
	return e.project.RepoStage(ctx, directory, paths)
}

func (e *Engine) RepoUnstage(ctx context.Context, directory string, paths []string) error {
	return e.project.RepoUnstage(ctx, directory, paths)
}

func (e *Engine) RepoCommitStaged(ctx context.Context, directory, message string) (string, error) {
	return e.project.RepoCommitStaged(ctx, directory, message)
}

func (e *Engine) RepoPush(ctx context.Context, directory string) error {
	return e.project.RepoPush(ctx, directory)
}

func (e *Engine) RepoCommitMessage(ctx context.Context, directory string) (string, error) {
	return e.project.RepoCommitMessage(ctx, directory)
}

func (e *Engine) CreateWorktree(ctx context.Context, directory, key, branch string) (code.Worktree, error) {
	return e.project.CreateWorktree(ctx, directory, key, branch)
}

func (e *Engine) CreateWorktreeFrom(ctx context.Context, directory, key, branch, base string) (code.Worktree, error) {
	return e.project.CreateWorktreeFrom(ctx, directory, key, branch, base)
}

func (e *Engine) ListWorktrees(ctx context.Context, directory string) ([]code.Worktree, error) {
	return e.project.ListWorktrees(ctx, directory)
}

func (e *Engine) MergeWorktree(ctx context.Context, path string) error {
	return e.project.MergeWorktree(ctx, path)
}

func (e *Engine) RemoveWorktree(ctx context.Context, path string) error {
	return e.project.RemoveWorktree(ctx, path)
}

func (e *Engine) FileStatus(ctx context.Context, directory, path string) (code.Status, error) {
	return e.project.FileStatus(ctx, directory, path)
}

func (e *Engine) FileIdentity(ctx context.Context, directory, path string) (code.Identity, error) {
	return e.project.FileIdentity(ctx, directory, path)
}

func (e *Engine) FindFiles(ctx context.Context, directory, query string, limit int) ([]string, error) {
	return e.project.FindFiles(ctx, directory, query, limit)
}

func (e *Engine) ReadFile(ctx context.Context, directory, path string) (project.FileContent, error) {
	return e.project.ReadFile(ctx, directory, path)
}

func (e *Engine) WriteFile(ctx context.Context, directory, path, content, expected string, force bool) (string, error) {
	return e.project.WriteFile(ctx, directory, path, content, expected, force)
}

func (e *Engine) ReviewAccept(ctx context.Context, id, message event.ID, files []review.File) (review.Status, error) {
	return e.project.ReviewAccept(ctx, id, message, files)
}

func (e *Engine) ReviewReject(ctx context.Context, id, message event.ID, files []review.File) (review.Status, error) {
	return e.project.ReviewReject(ctx, id, message, files)
}

func (e *Engine) ReviewUndo(ctx context.Context, id event.ID) (review.Status, error) {
	return e.project.ReviewUndo(ctx, id)
}

func (e *Engine) ReviewStatus(ctx context.Context, id event.ID) (review.Status, error) {
	return e.project.ReviewStatus(ctx, id)
}

func (e *Engine) SetDirectoryWatchInterval(interval time.Duration) {
	e.project.SetDirectoryWatchInterval(interval)
}

func (e *Engine) WatchDirectory(ctx context.Context, owner, directory string) error {
	return e.project.WatchDirectory(ctx, owner, directory)
}

func (e *Engine) UnwatchDirectories(owner string) { e.project.UnwatchDirectories(owner) }

func (e *Engine) ListTerminals(directory string) []terminal.Info {
	return e.project.ListTerminals(directory)
}

func (e *Engine) CreateTerminal(ctx context.Context, options terminal.CreateOptions) (terminal.Info, error) {
	return e.project.CreateTerminal(ctx, options)
}

func (e *Engine) Terminal(id event.ID) (terminal.Info, error) { return e.project.Terminal(id) }

func (e *Engine) RemoveTerminal(ctx context.Context, id event.ID) error {
	return e.project.RemoveTerminal(ctx, id)
}

func (e *Engine) UpdateTerminal(ctx context.Context, id event.ID, options terminal.UpdateOptions) (terminal.Info, error) {
	return e.project.UpdateTerminal(ctx, id, options)
}

func (e *Engine) SubscribeTerminal(id event.ID, cursor uint64) (*terminal.Subscription, error) {
	return e.project.SubscribeTerminal(id, cursor)
}

func (e *Engine) WriteTerminal(id event.ID, body []byte) error {
	return e.project.WriteTerminal(id, body)
}

func (e *Engine) DeleteAgent(ctx context.Context, human, id event.ID) error {
	return e.adminDefinition.DeleteAgent(ctx, human, id)
}

func (e *Engine) SaveAgent(ctx context.Context, human event.ID, p definition.Agent) (definition.Agent, error) {
	return e.adminDefinition.SaveAgent(ctx, human, p)
}

func (e *Engine) SkillList(ctx context.Context, directory string) (skill.Set, error) {
	return e.adminSkill.SkillList(ctx, directory)
}

func (e *Engine) SkillSources() []string {
	return e.adminSkill.SkillSources()
}

func (e *Engine) SkillDiscover(ctx context.Context, source, token string) ([]adminskill.Offer, error) {
	return e.adminSkill.SkillDiscover(ctx, source, token)
}

func (e *Engine) SkillInstall(ctx context.Context, source, token string, names []string, scope, directory string) ([]string, error) {
	return e.adminSkill.SkillInstall(ctx, source, token, names, scope, directory)
}

func (e *Engine) SkillUninstall(ctx context.Context, name, scope, directory string) error {
	return e.adminSkill.SkillUninstall(ctx, name, scope, directory)
}

func (e *Engine) Rules(ctx context.Context, directory string) (rules.Set, error) {
	return rules.Load(ctx, directory)
}

func (e *Engine) WriteRule(root, name, text string) (string, error) {
	return adminrules.WriteFile(root, name, text)
}

func (e *Engine) DeleteRule(root, name string) error {
	return adminrules.DeleteFile(root, name)
}

func (e *Engine) MCPStatus(ctx context.Context, directory string) ([]mcp.Status, error) {
	return e.adminMCP.MCPStatus(ctx, directory)
}

func (e *Engine) MCPAuthenticate(ctx context.Context, name string) (string, error) {
	return e.adminMCP.MCPAuthenticate(ctx, name)
}

func (e *Engine) MCPLogout(ctx context.Context, name string) error {
	return e.adminMCP.MCPLogout(ctx, name)
}

func (e *Engine) MemoryList(ctx context.Context, directory, scope string) ([]memory.Note, error) {
	return e.adminMemory.MemoryList(ctx, directory, scope)
}

func (e *Engine) MemoryRead(ctx context.Context, id event.ID) (memory.Note, error) {
	return e.adminMemory.MemoryRead(ctx, id)
}

func (e *Engine) MemoryDelete(ctx context.Context, id event.ID) error {
	return e.adminMemory.MemoryDelete(ctx, id)
}
