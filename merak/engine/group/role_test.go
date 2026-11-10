package group_test

import (
	"context"
	"github.com/TongTong313/merakcode/merak/engine/event"
	"github.com/TongTong313/merakcode/merak/engine/group"
	"github.com/TongTong313/merakcode/merak/engine/store/memory"
	"testing"
	"time"
)

func TestTheFirstLocalHumanReceivesAllRoles(t *testing.T) {
	for _, adding := range []bool{false, true} {
		t.Run(map[bool]string{false: "created with the group", true: "added later"}[adding], func(t *testing.T) {
			ctx := context.Background()
			storage := memory.New()
			manager := group.New(storage, event.NewBus(storage, time.Now, event.NewID), event.NewID)
			members := []group.Member{{ID: "leader", Name: "Leader", Kind: group.MemberAgent, AgentRole: group.AgentLeader}}
			human := group.Member{ID: "human", Name: "Human", Kind: group.MemberHuman}
			if !adding {
				members = append(members, human)
			}
			g, err := manager.Create(ctx, group.Group{Name: "Local", Kind: group.KindLocal, Project: group.Project{Directory: t.TempDir()}, DefaultLeader: "leader"}, members)
			if err != nil {
				t.Fatal(err)
			}
			if adding {
				if _, err := manager.AddMember(ctx, g.ID, human); err != nil {
					t.Fatal(err)
				}
			}
			state, err := manager.Get(ctx, g.ID)
			if err != nil {
				t.Fatal(err)
			}
			member := state.Members[1]
			for _, role := range []group.Role{group.RoleApprover, group.RoleAdmin, group.RoleOwner} {
				if !member.Can(role) {
					t.Errorf("role=%s member=%+v", role, member)
				}
			}
		})
	}
}

func TestHumanRolesAreValidatedAndDefaultToMember(t *testing.T) {
	for _, role := range []string{"owner", "admin", "approver", "member", "observer", "", "root"} {
		t.Run(role, func(t *testing.T) {
			storage := memory.New()
			manager := group.New(storage, event.NewBus(storage, time.Now, event.NewID), event.NewID)
			g, err := manager.Create(t.Context(), group.Group{Name: "Roles", Kind: group.KindLocal, Project: group.Project{Directory: t.TempDir()}, DefaultLeader: "leader"}, []group.Member{
				{ID: "leader", Name: "Leader", Kind: group.MemberAgent, AgentRole: group.AgentLeader},
				{ID: "owner", Name: "Owner", Kind: group.MemberHuman, Role: "owner"},
				{ID: "human", Name: "Human", Kind: group.MemberHuman, Role: role},
			})
			if role == "root" {
				if err == nil {
					t.Fatal("unknown role accepted")
				}
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			state, err := manager.Get(t.Context(), g.ID)
			if err != nil {
				t.Fatal(err)
			}
			want := role
			if want == "" {
				want = "member"
			}
			if state.Members[2].Role != want {
				t.Fatalf("role=%s want=%s", state.Members[2].Role, want)
			}
		})
	}
}
