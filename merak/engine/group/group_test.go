package group_test

import (
	"context"
	"testing"
	"time"

	"github.com/TongTong313/merakcode/merak/engine/event"
	"github.com/TongTong313/merakcode/merak/engine/group"
	"github.com/TongTong313/merakcode/merak/engine/store/memory"
)

func TestLocalGroupRequiresAnActualLeaderAndRestoresItsMembers(t *testing.T) {
	for _, tc := range []struct {
		name     string
		kind     group.Kind
		role     group.AgentRole
		accepted bool
	}{
		{"local leader", group.KindLocal, group.AgentLeader, true},
		{"cloud rejected", "cloud", group.AgentLeader, false},
		{"worker rejected", group.KindLocal, group.AgentWorker, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			ctx := context.Background()
			storage := memory.New()
			bus := event.NewBus(storage, time.Now, event.NewID)
			manager := group.New(storage, bus, event.NewID)
			created, err := manager.Create(ctx, group.Group{Kind: tc.kind, Name: "Project", Leader: "leader", Project: group.Project{Directory: t.TempDir()}}, []group.Member{{ID: "leader", Name: "Leader", Kind: group.MemberAgent, AgentRole: tc.role}})
			if !tc.accepted {
				if err == nil {
					t.Fatal("invalid group accepted")
				}
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			if _, err := manager.AddMember(ctx, created.ID, group.Member{ID: "worker", Kind: group.MemberAgent, AgentRole: group.AgentWorker, Name: "Worker"}); err != nil {
				t.Fatal(err)
			}
			restored, err := group.New(storage, bus, event.NewID).Get(ctx, created.ID)
			if err != nil || restored.Group.Leader != "leader" || len(restored.Members) != 2 || restored.Members[1].Group != created.ID {
				t.Fatalf("group=%+v err=%v", restored, err)
			}
		})
	}
}

func TestAnAdminRenamesAMemberAndTheNewNameMustStayMentionableAndUnique(t *testing.T) {
	ctx := context.Background()
	storage := memory.New()
	bus := event.NewBus(storage, time.Now, event.NewID)
	manager := group.New(storage, bus, event.NewID)
	created, err := manager.Create(ctx, group.Group{Kind: group.KindLocal, Name: "Project", Leader: "leader", Project: group.Project{Directory: t.TempDir()}}, []group.Member{
		{ID: "owner", Name: "Owner", Kind: group.MemberHuman, Role: group.RoleOwner},
		{ID: "guest", Name: "Guest", Kind: group.MemberHuman, Role: group.RoleMember},
		{ID: "leader", Name: "Leader", Kind: group.MemberAgent, AgentRole: group.AgentLeader},
		{ID: "worker", Name: "Worker", Kind: group.MemberAgent, AgentRole: group.AgentWorker},
	})
	if err != nil {
		t.Fatal(err)
	}
	renamed, err := manager.RenameMember(ctx, created.ID, "owner", "worker", "  Writer ")
	if err != nil || renamed.Name != "Writer" || renamed.AgentRole != group.AgentWorker {
		t.Fatalf("renamed=%+v err=%v", renamed, err)
	}
	restored, err := group.New(storage, bus, event.NewID).Get(ctx, created.ID)
	if err != nil {
		t.Fatal(err)
	}
	names := map[string]string{}
	for _, member := range restored.Members {
		names[string(member.ID)] = member.Name
	}
	if names["worker"] != "Writer" || names["leader"] != "Leader" {
		t.Fatalf("names after restoring: %v", names)
	}
	for name, test := range map[string]struct {
		human, member event.ID
		to            string
	}{
		"an empty name":          {"owner", "worker", "   "},
		"a name with a space":    {"owner", "worker", "Fast Writer"},
		"a name with an at sign": {"owner", "worker", "@Writer"},
		"a name already taken":   {"owner", "worker", "leader"},
		"a plain member":         {"guest", "worker", "Poet"},
		"an unknown member":      {"owner", "ghost", "Poet"},
	} {
		if _, err := manager.RenameMember(ctx, created.ID, test.human, test.member, test.to); err == nil {
			t.Errorf("%s was accepted", name)
		}
	}
}
