// Package schema lists the methods of the protocol with the Go types of their parameters and results. The schema
// generator and the server's tests read the same list.
package schema

import (
	"reflect"

	"github.com/TongTong313/merakcode/merak/engine"
	"github.com/TongTong313/merakcode/merak/engine/agent"
	"github.com/TongTong313/merakcode/merak/engine/code"
	"github.com/TongTong313/merakcode/merak/engine/command"
	"github.com/TongTong313/merakcode/merak/engine/event"
	"github.com/TongTong313/merakcode/merak/engine/group"
	"github.com/TongTong313/merakcode/merak/engine/leader"
	"github.com/TongTong313/merakcode/merak/engine/mcp"
	"github.com/TongTong313/merakcode/merak/engine/memory"
	"github.com/TongTong313/merakcode/merak/engine/model/catalog"
	"github.com/TongTong313/merakcode/merak/engine/plan"
	"github.com/TongTong313/merakcode/merak/engine/review"
	"github.com/TongTong313/merakcode/merak/engine/schedule"
	"github.com/TongTong313/merakcode/merak/engine/session"
	"github.com/TongTong313/merakcode/merak/engine/skill"
	"github.com/TongTong313/merakcode/merak/engine/store"
	"github.com/TongTong313/merakcode/merak/engine/task"
	"github.com/TongTong313/merakcode/merak/engine/terminal"
	"github.com/TongTong313/merakcode/merak/engine/worker"
	"github.com/TongTong313/merakcode/merak/internal/platform/git"
	"github.com/TongTong313/merakcode/merak/internal/platform/sandbox"
	"github.com/TongTong313/merakcode/merak/protocol"
)

// Method is one method of the protocol.
type Method struct {
	Name           string
	Params, Result reflect.Type
}

// Methods returns every method of the protocol.
func Methods() []Method {
	return []Method{
		{"hello", reflect.TypeFor[protocol.HelloParams](), reflect.TypeFor[protocol.HelloResult]()},
		{"engine.stop", reflect.TypeFor[struct{}](), reflect.TypeFor[struct{}]()},
		{"engine.status", reflect.TypeFor[struct{}](), reflect.TypeFor[protocol.EngineStatus]()},
		{"cloud.login", reflect.TypeFor[protocol.CloudLoginParams](), reflect.TypeFor[protocol.CloudStatus]()},
		{"cloud.logout", reflect.TypeFor[struct{}](), reflect.TypeFor[struct{}]()},
		{"cloud.status", reflect.TypeFor[struct{}](), reflect.TypeFor[protocol.CloudStatus]()},
		{"cloud.members", reflect.TypeFor[struct{}](), reflect.TypeFor[[]group.Member]()},
		{"config.get", reflect.TypeFor[struct{}](), reflect.TypeFor[protocol.Config]()},
		{"config.set", reflect.TypeFor[protocol.ConfigPatch](), reflect.TypeFor[protocol.Config]()},
		{"plan.get", reflect.TypeFor[protocol.PlanParams](), reflect.TypeFor[plan.Plan]()},
		{"plan.save", reflect.TypeFor[protocol.PlanSaveParams](), reflect.TypeFor[plan.Plan]()},
		{"plan.execute", reflect.TypeFor[protocol.PlanParams](), reflect.TypeFor[plan.Plan]()},
		{"plan.stop", reflect.TypeFor[protocol.PlanParams](), reflect.TypeFor[plan.Plan]()},
		{"command.list", reflect.TypeFor[protocol.DirectoryParams](), reflect.TypeFor[[]command.Command]()},
		{"session.command", reflect.TypeFor[protocol.SessionCommandParams](), reflect.TypeFor[command.Result]()},
		{"skill.list", reflect.TypeFor[protocol.DirectoryParams](), reflect.TypeFor[protocol.SkillListResult]()},
		{"skill.discover", reflect.TypeFor[protocol.SkillDiscoverParams](), reflect.TypeFor[[]skill.Offer]()},
		{"skill.install", reflect.TypeFor[protocol.SkillInstallParams](), reflect.TypeFor[protocol.SkillInstallResult]()},
		{"skill.uninstall", reflect.TypeFor[protocol.SkillUninstallParams](), reflect.TypeFor[struct{}]()},
		{"rules.read", reflect.TypeFor[protocol.DirectoryParams](), reflect.TypeFor[protocol.RulesReadResult]()},
		{"rules.change", reflect.TypeFor[protocol.RulesChangeParams](), reflect.TypeFor[struct{}]()},
		{"memory.list", reflect.TypeFor[protocol.MemoryListParams](), reflect.TypeFor[[]memory.Note]()},
		{"memory.read", reflect.TypeFor[protocol.MemoryNoteParams](), reflect.TypeFor[memory.Note]()},
		{"memory.delete", reflect.TypeFor[protocol.MemoryNoteParams](), reflect.TypeFor[struct{}]()},
		{"mcp.status", reflect.TypeFor[protocol.MCPStatusParams](), reflect.TypeFor[[]mcp.Status]()},
		{"mcp.authenticate", reflect.TypeFor[protocol.MCPServerParams](), reflect.TypeFor[protocol.MCPAuthenticateResult]()},
		{"mcp.logout", reflect.TypeFor[protocol.MCPServerParams](), reflect.TypeFor[struct{}]()},
		{"model.list", reflect.TypeFor[protocol.ModelListParams](), reflect.TypeFor[[]catalog.Model]()},
		{"agent.catalog", reflect.TypeFor[struct{}](), reflect.TypeFor[[]worker.ProductInfo]()},
		{"worker.run", reflect.TypeFor[protocol.WorkerRunParams](), reflect.TypeFor[task.Report]()},
		{"sandbox.status", reflect.TypeFor[protocol.SandboxStatusParams](), reflect.TypeFor[sandbox.Status]()},
		{"sandbox.setup", reflect.TypeFor[struct{}](), reflect.TypeFor[struct{}]()},
		{"remote.connect", reflect.TypeFor[protocol.RemoteConnectParams](), reflect.TypeFor[protocol.RemoteConnection]()},
		{"remote.members", reflect.TypeFor[struct{}](), reflect.TypeFor[[]protocol.RemoteMember]()},
		{"remote.start", reflect.TypeFor[protocol.RemoteStartParams](), reflect.TypeFor[protocol.RemoteStartResult]()},
		{"remote.deliver", reflect.TypeFor[protocol.RemoteDeliveryParams](), reflect.TypeFor[protocol.RemoteDelivery]()},
		{"remote.sync", reflect.TypeFor[protocol.RemoteSyncParams](), reflect.TypeFor[struct{}]()},
		{"remote.control", reflect.TypeFor[protocol.RemoteControlParams](), reflect.TypeFor[struct{}]()},
		{"agent.test", reflect.TypeFor[protocol.AgentSaveParams](), reflect.TypeFor[worker.Caps]()},
		{"agent.list", reflect.TypeFor[protocol.AgentListParams](), reflect.TypeFor[[]agent.Agent]()},
		{"agent.save", reflect.TypeFor[protocol.AgentSaveParams](), reflect.TypeFor[agent.Agent]()},
		{"agent.delete", reflect.TypeFor[protocol.AgentDeleteParams](), reflect.TypeFor[struct{}]()},
		{"group.create", reflect.TypeFor[protocol.GroupCreateParams](), reflect.TypeFor[group.Group]()},
		{"group.bind", reflect.TypeFor[protocol.GroupBindParams](), reflect.TypeFor[task.Card]()},
		{"group.list", reflect.TypeFor[struct{}](), reflect.TypeFor[[]group.Listing]()},
		{"task.list", reflect.TypeFor[protocol.TaskListParams](), reflect.TypeFor[[]task.Card]()},
		{"task.archive", reflect.TypeFor[protocol.TaskArchiveParams](), reflect.TypeFor[[]task.Card]()},
		{"group.update", reflect.TypeFor[protocol.GroupUpdateParams](), reflect.TypeFor[group.Group]()},
		{"group.addMember", reflect.TypeFor[protocol.GroupAddMemberParams](), reflect.TypeFor[group.Member]()},
		{"group.removeMember", reflect.TypeFor[protocol.GroupRemoveMemberParams](), reflect.TypeFor[struct{}]()},
		{"group.renameMember", reflect.TypeFor[protocol.GroupRenameMemberParams](), reflect.TypeFor[group.Member]()},
		{"group.state", reflect.TypeFor[protocol.GroupIDParams](), reflect.TypeFor[leader.View]()},
		{"group.pause", reflect.TypeFor[protocol.GroupControlParams](), reflect.TypeFor[struct{}]()},
		{"group.resume", reflect.TypeFor[protocol.GroupControlParams](), reflect.TypeFor[struct{}]()},
		{"doc.list", reflect.TypeFor[protocol.GroupIDParams](), reflect.TypeFor[[]group.DocumentInfo]()},
		{"doc.read", reflect.TypeFor[protocol.DocReadParams](), reflect.TypeFor[group.Document]()},
		{"doc.write", reflect.TypeFor[protocol.DocWriteParams](), reflect.TypeFor[group.Document]()},
		{"task.create", reflect.TypeFor[protocol.TaskCreateParams](), reflect.TypeFor[task.Card]()},
		{"group.say", reflect.TypeFor[protocol.GroupSayParams](), reflect.TypeFor[event.ID]()},
		{"task.assign", reflect.TypeFor[protocol.TaskAssignParams](), reflect.TypeFor[task.Claim]()},
		{"task.review", reflect.TypeFor[protocol.TaskReviewParams](), reflect.TypeFor[struct{}]()},
		{"task.update", reflect.TypeFor[protocol.TaskUpdateParams](), reflect.TypeFor[task.Card]()},
		{"task.cancel", reflect.TypeFor[protocol.TaskCancelParams](), reflect.TypeFor[task.Card]()},
		{"model.refresh", reflect.TypeFor[protocol.ModelRefreshParams](), reflect.TypeFor[[]catalog.Model]()},
		{"model.discover", reflect.TypeFor[protocol.ModelDiscoverParams](), reflect.TypeFor[[]catalog.Model]()},
		{"diagnostics.bundle", reflect.TypeFor[protocol.DiagnosticsParams](), reflect.TypeFor[protocol.DiagnosticsResult]()},
		{"blob.read", reflect.TypeFor[protocol.BlobReadParams](), reflect.TypeFor[protocol.BlobReadResult]()},
		{"terminal.list", reflect.TypeFor[protocol.DirectoryParams](), reflect.TypeFor[[]terminal.Info]()},
		{"terminal.create", reflect.TypeFor[terminal.CreateOptions](), reflect.TypeFor[terminal.Info]()},
		{"terminal.get", reflect.TypeFor[protocol.TerminalIDParams](), reflect.TypeFor[terminal.Info]()},
		{"terminal.update", reflect.TypeFor[protocol.TerminalUpdateParams](), reflect.TypeFor[terminal.Info]()},
		{"terminal.remove", reflect.TypeFor[protocol.TerminalIDParams](), reflect.TypeFor[struct{}]()},
		{"file.read", reflect.TypeFor[protocol.FileParams](), reflect.TypeFor[engine.FileContent]()},
		{"file.write", reflect.TypeFor[protocol.FileWriteParams](), reflect.TypeFor[protocol.FileWriteResult]()},
		{"file.list", reflect.TypeFor[protocol.FileParams](), reflect.TypeFor[[]engine.FileNode]()},
		{"repo.status", reflect.TypeFor[protocol.DirectoryParams](), reflect.TypeFor[git.State]()},
		{"repo.diff", reflect.TypeFor[protocol.RepoDiffParams](), reflect.TypeFor[[]git.Change]()},
		{"review.accept", reflect.TypeFor[protocol.ReviewDecideParams](), reflect.TypeFor[review.Status]()},
		{"review.reject", reflect.TypeFor[protocol.ReviewDecideParams](), reflect.TypeFor[review.Status]()},
		{"review.undo", reflect.TypeFor[protocol.SessionCancelParams](), reflect.TypeFor[review.Status]()},
		{"review.status", reflect.TypeFor[protocol.SessionCancelParams](), reflect.TypeFor[review.Status]()},
		{"repo.branches", reflect.TypeFor[protocol.DirectoryParams](), reflect.TypeFor[[]git.Branch]()},
		{"repo.checkout", reflect.TypeFor[protocol.RepoCheckoutParams](), reflect.TypeFor[struct{}]()},
		{"repo.commit", reflect.TypeFor[protocol.RepoCommitParams](), reflect.TypeFor[protocol.RepoCommitResult]()},
		{"repo.stage", reflect.TypeFor[protocol.RepoPathsParams](), reflect.TypeFor[struct{}]()},
		{"repo.unstage", reflect.TypeFor[protocol.RepoPathsParams](), reflect.TypeFor[struct{}]()},
		{"repo.push", reflect.TypeFor[protocol.DirectoryParams](), reflect.TypeFor[struct{}]()},
		{"repo.commitMessage", reflect.TypeFor[protocol.DirectoryParams](), reflect.TypeFor[protocol.RepoCommitMessageResult]()},
		{"worktree.create", reflect.TypeFor[protocol.WorktreeCreateParams](), reflect.TypeFor[code.Worktree]()},
		{"worktree.list", reflect.TypeFor[protocol.DirectoryParams](), reflect.TypeFor[[]code.Worktree]()},
		{"worktree.merge", reflect.TypeFor[protocol.WorktreePathParams](), reflect.TypeFor[struct{}]()},
		{"worktree.remove", reflect.TypeFor[protocol.WorktreePathParams](), reflect.TypeFor[struct{}]()},
		{"file.status", reflect.TypeFor[protocol.FileParams](), reflect.TypeFor[code.Status]()},
		{"file.identity", reflect.TypeFor[protocol.FileParams](), reflect.TypeFor[code.Identity]()},
		{"file.find", reflect.TypeFor[protocol.FileFindParams](), reflect.TypeFor[[]string]()},
		{"session.create", reflect.TypeFor[protocol.SessionCreateParams](), reflect.TypeFor[protocol.SessionCreateResult]()},
		{"session.send", reflect.TypeFor[protocol.SessionSendParams](), reflect.TypeFor[struct{}]()},
		{"session.cancel", reflect.TypeFor[protocol.SessionCancelParams](), reflect.TypeFor[struct{}]()},
		{"session.list", reflect.TypeFor[protocol.SessionListParams](), reflect.TypeFor[[]session.Info]()},
		{"session.update", reflect.TypeFor[protocol.SessionUpdateParams](), reflect.TypeFor[struct{}]()},
		{"session.revert", reflect.TypeFor[protocol.SessionRevertParams](), reflect.TypeFor[struct{}]()},
		{"session.unrevert", reflect.TypeFor[protocol.SessionCancelParams](), reflect.TypeFor[struct{}]()},
		{"session.compact", reflect.TypeFor[protocol.SessionCancelParams](), reflect.TypeFor[struct{}]()},
		{"session.delete", reflect.TypeFor[protocol.SessionCancelParams](), reflect.TypeFor[struct{}]()},
		{"session.search", reflect.TypeFor[protocol.SessionSearchParams](), reflect.TypeFor[[]session.Hit]()},
		{"session.export", reflect.TypeFor[protocol.SessionCancelParams](), reflect.TypeFor[[]event.Event]()},
		{"session.import", reflect.TypeFor[protocol.SessionImportParams](), reflect.TypeFor[protocol.SessionCreateResult]()},
		{"session.snapshot", reflect.TypeFor[protocol.SessionCancelParams](), reflect.TypeFor[session.State]()},
		{"events.read", reflect.TypeFor[protocol.EventsReadParams](), reflect.TypeFor[[]event.Event]()},
		{"events.find", reflect.TypeFor[store.Query](), reflect.TypeFor[[]event.Event]()},
		{"events.get", reflect.TypeFor[protocol.EventsGetParams](), reflect.TypeFor[event.Event]()},
		{"event.emit", reflect.TypeFor[protocol.EventEmitParams](), reflect.TypeFor[event.Event]()},
		{"permission.reply", reflect.TypeFor[protocol.PermissionReplyParams](), reflect.TypeFor[struct{}]()},
		{"question.reply", reflect.TypeFor[protocol.QuestionReplyParams](), reflect.TypeFor[struct{}]()},
		{"schedule.list", reflect.TypeFor[struct{}](), reflect.TypeFor[[]schedule.Schedule]()},
		{"schedule.delete", reflect.TypeFor[protocol.ScheduleDeleteParams](), reflect.TypeFor[struct{}]()},
		{"import.start", reflect.TypeFor[protocol.ImportStartParams](), reflect.TypeFor[protocol.ImportStartResult]()},
		{"import.status", reflect.TypeFor[struct{}](), reflect.TypeFor[protocol.ImportStatus]()},
		{"tool.register", reflect.TypeFor[protocol.ToolRegisterParams](), reflect.TypeFor[struct{}]()},
		{"tool.unregister", reflect.TypeFor[protocol.ToolUnregisterParams](), reflect.TypeFor[struct{}]()},
		{"tool.result", reflect.TypeFor[protocol.ToolResultParams](), reflect.TypeFor[struct{}]()},
		{"events.subscribe", reflect.TypeFor[event.Filter](), reflect.TypeFor[protocol.SubscribeResult]()},
		{"events.unsubscribe", reflect.TypeFor[protocol.UnsubscribeParams](), reflect.TypeFor[struct{}]()},
	}
}
