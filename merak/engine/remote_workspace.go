package engine

import (
	"context"
	"errors"
	"path/filepath"

	"github.com/TongTong313/merakcode/merak/engine/agent"
	"github.com/TongTong313/merakcode/merak/engine/group"
	"github.com/TongTong313/merakcode/merak/engine/worker"
	"github.com/TongTong313/merakcode/merak/engine/worker/remote"
	"github.com/TongTong313/merakcode/merak/internal/platform/git"
)

func (e *Engine) configureMemberCheckout(ctx context.Context, member *group.Member, p agent.Agent) error {
	member.Remote = p.Product != nil && p.Product.Kind == worker.KindRemote
	if member.Remote {
		if member.AgentRole != group.AgentWorker || p.Product.Remote == nil {
			return errors.New("MRK-6001: remote members can only act as workers")
		}
		source := p.Product.Remote
		creds, err := e.remoteCredentials(ctx, source.Connection)
		if err != nil {
			return err
		}
		members, err := remote.Members(ctx, creds.Endpoint, creds.Token)
		if err != nil {
			return err
		}
		for _, candidate := range members {
			if candidate.Member.Group == source.Group && candidate.Member.ID == source.Member {
				member.Checkouts = candidate.Member.Checkouts
				return nil
			}
		}
		return errors.New("MRK-6001: remote source member is not registered")
	}
	checkouts := map[string]string{}
	for remote, path := range member.Checkouts {
		root, err := git.Root(ctx, path)
		if err != nil {
			return err
		}
		resolved, err := filepath.EvalSymlinks(path)
		if err != nil {
			return err
		}
		resolved, err = filepath.Abs(resolved)
		if err != nil || root != resolved {
			return errors.New("checkout must name the repository root")
		}
		if _, err := git.ProjectRemote(ctx, root, remote); err != nil || remote == "" {
			return errors.New("checkout remote is not configured")
		}
		checkouts[remote] = root
	}
	member.Checkouts = checkouts
	return nil
}
