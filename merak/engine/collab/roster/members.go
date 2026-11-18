package roster

import (
	"context"
	"errors"

	"github.com/TongTong313/merakcode/merak/engine/agent/definition"
	"github.com/TongTong313/merakcode/merak/engine/collab/group"
	"github.com/TongTong313/merakcode/merak/engine/infra/errorcode"
	"github.com/TongTong313/merakcode/merak/engine/infra/event"
	"github.com/TongTong313/merakcode/merak/engine/infra/store"
)

func (domain *Roster) MemberAgent(ctx context.Context, member group.Member) (definition.Agent, error) {
	found, _, err := domain.LoadAgent(ctx, member)
	return found, err
}

// LoadAgent reads the agent of a member and the human who owns it; the built-in agents have no owner.
func (domain *Roster) LoadAgent(ctx context.Context, member group.Member) (definition.Agent, event.ID, error) {
	if member.Agent == "" {
		for _, p := range domain.registry.BuiltinAgents() {
			return p, "", nil
		}
	}
	return domain.registry.DefinitionByID(ctx, member.Agent)
}

func (domain *Roster) GroupMember(ctx context.Context, groupID, memberID event.ID) (group.Member, error) {
	state, err := domain.groups.Get(ctx, groupID)
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

func (domain *Roster) AuthorizeMemberAssignment(ctx context.Context, member group.Member, actor event.Actor) error {
	if actor.Kind == event.ActorAgent && actor.ID == member.ID {
		return nil // a member may claim for itself
	}
	p, err := domain.MemberAgent(ctx, member)
	if err != nil {
		return err
	}
	if !p.Shared && (actor.Kind != event.ActorHuman || actor.ID != member.Owner) {
		return errorcode.Coded(errorcode.ProfileOwnerOnly, errors.New("only the owner can assign an unshared member"))
	}
	return nil
}
