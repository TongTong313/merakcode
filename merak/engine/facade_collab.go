package engine

import (
	"context"
	"encoding/json"

	"github.com/TongTong313/merakcode/merak/engine/agent/definition"
	"github.com/TongTong313/merakcode/merak/engine/agent/permission"
	"github.com/TongTong313/merakcode/merak/engine/agent/session"
	"github.com/TongTong313/merakcode/merak/engine/collab/group"
	"github.com/TongTong313/merakcode/merak/engine/collab/leader"
	"github.com/TongTong313/merakcode/merak/engine/collab/remote"
	"github.com/TongTong313/merakcode/merak/engine/collab/task"
	"github.com/TongTong313/merakcode/merak/engine/collab/wire"
	"github.com/TongTong313/merakcode/merak/engine/collab/worker"
	"github.com/TongTong313/merakcode/merak/engine/collab/workspace"
	"github.com/TongTong313/merakcode/merak/engine/infra/event"
	"github.com/TongTong313/merakcode/merak/engine/infra/sandbox"
)

func (e *Engine) ListGroupDocuments(ctx context.Context, id event.ID) ([]group.DocumentInfo, error) {
	return e.roster.ListGroupDocuments(ctx, id)
}

func (e *Engine) ReadGroupDocument(ctx context.Context, id event.ID, key string) (group.Document, error) {
	return e.roster.ReadGroupDocument(ctx, id, key)
}

func (e *Engine) WriteGroupDocument(ctx context.Context, actor event.Actor, doc group.Document) (group.Document, error) {
	return e.roster.WriteGroupDocument(ctx, actor, doc)
}

func (e *Engine) ExternalAgent(ctx context.Context, id event.ID) (event.ID, error) {
	return e.execution.ExternalAgent(ctx, id)
}

func (e *Engine) TakeOverSession(ctx context.Context, id event.ID, confirm bool, selection session.Selection) error {
	return e.execution.TakeOverSession(ctx, id, confirm, selection)
}

func (e *Engine) EmitEvent(ctx context.Context, groupID event.ID, kind event.Type, payload json.RawMessage) (event.Event, error) {
	return e.execution.EmitEvent(ctx, groupID, kind, payload)
}

func (e *Engine) TestAgent(ctx context.Context, human event.ID, p definition.Agent) (definition.Caps, error) {
	return e.execution.TestAgent(ctx, human, p)
}

func (e *Engine) SetupSandbox(ctx context.Context) error { return e.execution.SetupSandbox(ctx) }

func (e *Engine) MemberSandboxStatus(ctx context.Context, groupID, memberID, sessionID event.ID) (sandbox.Status, error) {
	return e.execution.MemberSandboxStatus(ctx, groupID, memberID, sessionID)
}

func (e *Engine) SandboxStatus(ctx context.Context, workdir string, mode permission.Mode, sessions ...event.ID) (sandbox.Status, error) {
	return e.execution.SandboxStatus(ctx, workdir, mode, sessions...)
}

func (e *Engine) UpdateTask(ctx context.Context, id event.ID, change task.Update, actor event.Actor) error {
	return e.execution.UpdateTask(ctx, id, change, actor)
}

func (e *Engine) StartWorker(ctx context.Context, p definition.Agent, a worker.Assignment) (worker.Run, error) {
	return e.execution.StartWorker(ctx, p, a)
}

func (e *Engine) WorkerProducts(ctx context.Context) []worker.ProductInfo {
	return e.execution.WorkerProducts(ctx)
}

func (e *Engine) ConnectCloud(ctx context.Context, creds wire.Credentials) error {
	return e.remote.ConnectCloud(ctx, creds)
}

func (e *Engine) CloudStatus() wire.CloudStatus { return e.remote.CloudStatus() }

func (e *Engine) CloudMembers(ctx context.Context) ([]group.Member, error) {
	return e.remote.CloudMembers(ctx)
}

func (e *Engine) DisconnectCloud(ctx context.Context) error { return e.remote.DisconnectCloud(ctx) }

func (e *Engine) DeviceMembers(ctx context.Context) ([]group.Member, error) {
	return e.remote.DeviceMembers(ctx)
}

func (e *Engine) ForwardCloud(ctx context.Context, method string, params json.RawMessage) (json.RawMessage, bool, error) {
	return e.remote.ForwardCloud(ctx, method, params)
}

func (e *Engine) RemoteMembers(ctx context.Context) ([]wire.RemoteMember, error) {
	return e.remote.RemoteMembers(ctx)
}

func (e *Engine) ConnectRemote(ctx context.Context, params wire.RemoteConnectParams) (wire.RemoteConnection, error) {
	return e.remote.ConnectRemote(ctx, params)
}

func (e *Engine) AttachRemotePeer(ctx context.Context, id event.ID) (*remote.RemotePeer, error) {
	return e.remote.AttachRemotePeer(ctx, id)
}

func (e *Engine) CreateGroup(ctx context.Context, g group.Group, members []group.Member) (group.Group, error) {
	return e.coordinator.CreateGroup(ctx, g, members)
}

func (e *Engine) CreateGroupForTask(ctx context.Context, g group.Group, members []group.Member, taskID event.ID) (group.Group, error) {
	return e.coordinator.CreateGroupForTask(ctx, g, members, taskID)
}

func (e *Engine) AddGroupMember(ctx context.Context, id, human event.ID, member group.Member) (group.Member, error) {
	return e.coordinator.AddGroupMember(ctx, id, human, member)
}

func (e *Engine) CreateTask(ctx context.Context, card task.Card) (task.Card, error) {
	return e.coordinator.CreateTask(ctx, card)
}

func (e *Engine) CreateAssignedTask(ctx context.Context, card task.Card, memberID event.ID) (task.Card, error) {
	return e.coordinator.CreateAssignedTask(ctx, card, memberID)
}

func (e *Engine) GroupState(ctx context.Context, id event.ID) (leader.View, error) {
	return e.coordinator.GroupState(ctx, id)
}

func (e *Engine) Group(ctx context.Context, id event.ID) (group.State, error) {
	return e.roster.Group(ctx, id)
}

func (e *Engine) ListGroups(ctx context.Context, human event.ID) ([]group.Group, error) {
	return e.roster.ListGroups(ctx, human)
}

func (e *Engine) GroupTasks(ctx context.Context, groupID event.ID) ([]task.Card, error) {
	return e.coordinator.GroupTasks(ctx, groupID)
}

func (e *Engine) Workspace(ctx context.Context, id event.ID) (workspace.Workspace, error) {
	return e.coordinator.Workspace(ctx, id)
}

func (e *Engine) ListTasks(ctx context.Context, filter task.Filter) ([]task.Card, error) {
	return e.coordinator.ListTasks(ctx, filter)
}

func (e *Engine) ArchiveTasks(ctx context.Context, ids []event.ID, archived bool, actor event.Actor) ([]task.Card, error) {
	return e.coordinator.ArchiveTasks(ctx, ids, archived, actor)
}

func (e *Engine) RemoveGroupMember(ctx context.Context, id, human, member event.ID) error {
	return e.coordinator.RemoveGroupMember(ctx, id, human, member)
}

func (e *Engine) RenameGroupMember(ctx context.Context, id, human, member event.ID, name string) (group.Member, error) {
	return e.coordinator.RenameGroupMember(ctx, id, human, member, name)
}

func (e *Engine) BoardGroups(ctx context.Context, human event.ID) ([]group.Listing, error) {
	return e.coordinator.BoardGroups(ctx, human)
}

func (e *Engine) Task(ctx context.Context, id event.ID) (task.Card, error) {
	return e.coordinator.Task(ctx, id)
}

func (e *Engine) AuthorizePermission(ctx context.Context, request, human event.ID) (event.ID, error) {
	return e.coordinator.AuthorizePermission(ctx, request, human)
}

func (e *Engine) PendingPermissions(ctx context.Context) ([]event.Event, error) {
	return e.coordinator.PendingPermissions(ctx)
}

func (e *Engine) AuthorizeQuestion(ctx context.Context, request, human event.ID) (event.ID, error) {
	return e.coordinator.AuthorizeQuestion(ctx, request, human)
}

func (e *Engine) AssignTask(ctx context.Context, id, human, member event.ID, role task.ClaimRole, scope []string) (task.Claim, error) {
	return e.coordinator.AssignTask(ctx, id, human, member, role, scope)
}

func (e *Engine) ReviewTask(ctx context.Context, id, human event.ID, decision, feedback string) error {
	return e.coordinator.ReviewTask(ctx, id, human, decision, feedback)
}

func (e *Engine) SayGroup(ctx context.Context, groupID, taskID, human event.ID, message group.Message) (event.ID, error) {
	return e.coordinator.SayGroup(ctx, groupID, taskID, human, message)
}

func (e *Engine) UpdateGroup(ctx context.Context, id, human event.ID, change group.Update) (group.Group, error) {
	return e.coordinator.UpdateGroup(ctx, id, human, change)
}

func (e *Engine) ConfigureBoard(autoArchiveDays int) { e.coordinator.ConfigureBoard(autoArchiveDays) }

func (e *Engine) BindTask(ctx context.Context, groupID, taskID, human event.ID) (task.Card, error) {
	return e.coordinator.BindTask(ctx, groupID, taskID, human)
}
