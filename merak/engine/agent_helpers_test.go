package engine_test

import (
	"context"
	"testing"

	"github.com/TongTong313/merakcode/merak/engine"
	"github.com/TongTong313/merakcode/merak/engine/agent"
	"github.com/TongTong313/merakcode/merak/engine/event"
	"github.com/TongTong313/merakcode/merak/engine/group"
)

// createGroup saves the agents a test defines for itself, each for the owner of the member that uses it, and then
// creates the group. Agents are made before a group refers to them, as they are in the product.
func createGroup(t testing.TB, e *engine.Engine, ctx context.Context, g group.Group, members []group.Member, agents []agent.Agent) (group.Group, error) {
	t.Helper()
	var owner event.ID
	for _, member := range members {
		if member.Kind != group.MemberHuman {
			continue
		}
		if owner == "" || member.Can(group.RoleOwner) {
			owner = member.ID
		}
		if member.Can(group.RoleOwner) {
			break
		}
	}
	if owner == "" {
		owner = "owner"
	}
	for _, a := range agents {
		keeper := owner
		for _, member := range members {
			if member.Agent == a.ID && member.Owner != "" {
				keeper = member.Owner
				break
			}
		}
		if _, err := e.SaveAgent(ctx, keeper, a); err != nil {
			return group.Group{}, err
		}
	}
	return e.CreateGroup(ctx, g, members)
}
