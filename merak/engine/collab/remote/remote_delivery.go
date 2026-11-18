package remote

import (
	"context"
	"encoding/json"
	"errors"

	"github.com/TongTong313/merakcode/merak/engine/agent/definition"
	"github.com/TongTong313/merakcode/merak/engine/collab/task"
	"github.com/TongTong313/merakcode/merak/engine/collab/wire"
	"github.com/TongTong313/merakcode/merak/engine/collab/workspace"
	"github.com/TongTong313/merakcode/merak/engine/infra/git"
)

func (p *RemotePeer) Deliver(ctx context.Context, params wire.RemoteDeliveryParams) (wire.RemoteDelivery, error) {
	var result wire.RemoteDelivery
	doc, err := p.owner.core.Store.Fetch(ctx, "device-run", string(params.Claim))
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
	ws, err := p.owner.workspaces.Get(ctx, record.Assignment.Claim.Workspace)
	if err != nil {
		return result, err
	}
	result.Branch = ws.Branch
	if params.Release {
		return result, p.owner.workspaces.Release(ctx, ws)
	}
	if ws.Kind != workspace.KindWorktree || ws.Released {
		return result, errors.New("MRK-6001: delivery requires an unreleased worktree")
	}
	state, err := p.owner.groups.Get(ctx, record.Assignment.Scope.Group)
	if err != nil {
		return result, err
	}
	return result, git.PushBranch(ctx, ws.Directory, state.Group.Project.Remote, ws.Branch, false)
}

func (domain *Remote) RemoteDelivery(ctx context.Context, source definition.RemoteSource, claim task.Claim, release bool) (wire.RemoteDelivery, error) {
	var result wire.RemoteDelivery
	if domain.dial == nil {
		return result, errors.New("MRK-3001")
	}
	creds, err := domain.RemoteCredentials(ctx, source.Connection)
	if err != nil {
		return result, err
	}
	client, err := domain.dial(ctx, creds.Endpoint, creds.Token, "merak-delivery")
	if err != nil {
		return result, err
	}
	defer client.Close()
	err = client.Call(ctx, "remote.deliver", wire.RemoteDeliveryParams{Host: source.Connection, Claim: claim.ID, Release: release}, &result)
	return result, err
}

func (domain *Remote) PrepareRemoteDelivery(ctx context.Context, card task.Card, claim task.Claim, source definition.RemoteSource) (workspace.Workspace, error) {
	result, err := domain.RemoteDelivery(ctx, source, claim, false)
	if err != nil {
		return workspace.Workspace{}, err
	}
	state, err := domain.groups.Get(ctx, card.Group)
	if err != nil {
		return workspace.Workspace{}, err
	}
	head, err := git.FetchBranch(ctx, state.Group.Project.Directory, state.Group.Project.Remote, result.Branch)
	if err != nil {
		return workspace.Workspace{}, err
	}
	ws, err := domain.workspaces.ForClaim(ctx, state.Group.Project.Directory, claim, card)
	if err != nil {
		return workspace.Workspace{}, err
	}
	defer func() { _ = domain.workspaces.EndClaim(context.WithoutCancel(ctx), ws) }()
	if err := git.FastForward(ctx, ws.Directory, ws.Branch, head); err != nil {
		return workspace.Workspace{}, err
	}
	if claim.Workspace == "" {
		if err := domain.tasks.BindWorkspace(ctx, claim.ID, ws.ID); err != nil {
			return workspace.Workspace{}, err
		}
	}
	return ws, nil
}
