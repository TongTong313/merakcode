package engine

import (
	"context"
	"encoding/json"
	"errors"

	"github.com/TongTong313/merakcode/merak/engine/agent"
	"github.com/TongTong313/merakcode/merak/engine/task"
	"github.com/TongTong313/merakcode/merak/engine/workspace"
	"github.com/TongTong313/merakcode/merak/internal/platform/git"
	"github.com/TongTong313/merakcode/merak/protocol"
)

func (p *RemotePeer) Deliver(ctx context.Context, params protocol.RemoteDeliveryParams) (protocol.RemoteDelivery, error) {
	var result protocol.RemoteDelivery
	doc, err := p.engine.store.Fetch(ctx, "device-run", string(params.Claim))
	if err != nil {
		return result, err
	}
	var record deviceRecord
	if err := json.Unmarshal(doc.Body, &record); err != nil {
		return result, err
	}
	if record.Account != p.host.id || record.Status != task.ClaimReported || record.Assignment.Claim.Workspace == "" {
		return result, errors.New("MRK-6001: remote delivery is not ready")
	}
	ws, err := p.engine.Workspaces.Get(ctx, record.Assignment.Claim.Workspace)
	if err != nil {
		return result, err
	}
	result.Branch = ws.Branch
	if params.Release {
		return result, p.engine.Workspaces.Release(ctx, ws)
	}
	if ws.Kind != workspace.KindWorktree || ws.Released {
		return result, errors.New("MRK-6001: delivery requires an unreleased worktree")
	}
	state, err := p.engine.Groups.Get(ctx, record.Assignment.Scope.Group)
	if err != nil {
		return result, err
	}
	return result, git.PushBranch(ctx, ws.Directory, state.Group.Project.Remote, ws.Branch, false)
}

func (e *Engine) remoteDelivery(ctx context.Context, source agent.RemoteSource, claim task.Claim, release bool) (protocol.RemoteDelivery, error) {
	var result protocol.RemoteDelivery
	creds, err := e.remoteCredentials(ctx, source.Connection)
	if err != nil {
		return result, err
	}
	client, err := protocol.Connect(ctx, creds.Endpoint, creds.Token, protocol.HelloParams{Protocol: protocol.Version, Client: protocol.ClientInfo{Name: "merak-delivery"}})
	if err != nil {
		return result, err
	}
	defer client.Close()
	err = client.Call(ctx, "remote.deliver", protocol.RemoteDeliveryParams{Host: source.Connection, Claim: claim.ID, Release: release}, &result)
	return result, err
}

func (e *Engine) prepareRemoteDelivery(ctx context.Context, card task.Card, claim task.Claim, source agent.RemoteSource) (workspace.Workspace, error) {
	result, err := e.remoteDelivery(ctx, source, claim, false)
	if err != nil {
		return workspace.Workspace{}, err
	}
	state, err := e.Groups.Get(ctx, card.Group)
	if err != nil {
		return workspace.Workspace{}, err
	}
	head, err := git.FetchBranch(ctx, state.Group.Project.Directory, state.Group.Project.Remote, result.Branch)
	if err != nil {
		return workspace.Workspace{}, err
	}
	ws, err := e.Workspaces.ForClaim(ctx, state.Group.Project.Directory, claim, card)
	if err != nil {
		return workspace.Workspace{}, err
	}
	defer func() { _ = e.Workspaces.EndClaim(context.WithoutCancel(ctx), ws) }()
	if err := git.FastForward(ctx, ws.Directory, ws.Branch, head); err != nil {
		return workspace.Workspace{}, err
	}
	if claim.Workspace == "" {
		if err := e.Tasks.BindWorkspace(ctx, claim.ID, ws.ID); err != nil {
			return workspace.Workspace{}, err
		}
	}
	return ws, nil
}
