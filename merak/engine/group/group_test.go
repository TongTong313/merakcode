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
			created, err := manager.Create(ctx, group.Group{Kind: tc.kind, Name: "Project", DefaultLeader: "leader", Project: group.Project{Directory: t.TempDir()}}, []group.Member{{ID: "leader", Name: "Leader", Kind: group.MemberAgent, AgentRole: tc.role}})
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
			if err != nil || restored.Group.DefaultLeader != "leader" || len(restored.Members) != 2 || restored.Members[1].Group != created.ID {
				t.Fatalf("group=%+v err=%v", restored, err)
			}
		})
	}
}
