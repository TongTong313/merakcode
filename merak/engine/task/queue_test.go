package task_test

import (
	"context"
	"github.com/TongTong313/merakcode/merak/engine/event"
	"github.com/TongTong313/merakcode/merak/engine/group"
	"github.com/TongTong313/merakcode/merak/engine/store/memory"
	"github.com/TongTong313/merakcode/merak/engine/task"
	"testing"
	"time"
)

func TestMemberQueueHonorsPriorityWithdrawalAndLeaderReordering(t *testing.T) {
	for _, tc := range []struct {
		name   string
		change string
		want   int
	}{
		{"higher priority first", "", 1},
		{"equal priority preserves assignment order", "equal", 0},
		{"leader changes priority", "raise", 0},
		{"leader withdraws queued claim", "withdraw", 0},
	} {
		t.Run(tc.name, func(t *testing.T) {
			ctx := context.Background()
			storage := memory.New()
			bus := event.NewBus(storage, time.Now, event.NewID)
			groups := group.New(storage, bus, event.NewID)
			g, err := groups.Create(ctx, group.Group{Kind: group.KindLocal, Name: "Project", Project: group.Project{Directory: t.TempDir()}, DefaultLeader: "leader"}, []group.Member{
				{ID: "leader", Name: "Leader", Kind: group.MemberAgent, AgentRole: group.AgentLeader},
				{ID: "worker", Name: "Worker", Kind: group.MemberAgent, AgentRole: group.AgentWorker},
			})
			if err != nil {
				t.Fatal(err)
			}
			pool := task.New(storage, bus, event.NewID, groups)
			var cards []task.Card
			var claims []task.Claim
			for _, priority := range []int{1, 2} {
				card, err := pool.Create(ctx, task.Card{Group: g.ID, Title: "Queued work", Priority: priority})
				if err != nil {
					t.Fatal(err)
				}
				claim, err := pool.OpenAndAssign(ctx, card.ID, "worker")
				if err != nil {
					t.Fatal(err)
				}
				cards = append(cards, card)
				claims = append(claims, claim)
			}
			if err := pool.Withdraw(ctx, claims[1].ID, "other-leader"); err == nil {
				t.Fatal("another leader withdrew the claim")
			}
			if err := pool.SetPriority(ctx, cards[0].ID, "other-leader", 10); err == nil {
				t.Fatal("another leader reordered the claim")
			}
			switch tc.change {
			case "equal":
				err = pool.SetPriority(ctx, cards[0].ID, "leader", 2)
			case "raise":
				err = pool.SetPriority(ctx, cards[0].ID, "leader", 3)
			case "withdraw":
				err = pool.Withdraw(ctx, claims[1].ID, "leader")
			}
			if err != nil {
				t.Fatal(err)
			}
			pool = task.New(storage, bus, event.NewID, groups)
			next, err := pool.Next(ctx, "worker")
			if err != nil || next.ID != claims[tc.want].ID {
				t.Fatalf("next=%+v err=%v", next, err)
			}
			if err := pool.Withdraw(ctx, next.ID, "leader"); err == nil {
				t.Fatal("active claim was withdrawn")
			}
			if tc.change == "withdraw" {
				card, err := pool.Get(ctx, cards[1].ID)
				if err != nil || card.Status != task.Open {
					t.Fatalf("withdrawn task=%+v err=%v", card, err)
				}
				if _, err := pool.Assign(ctx, card.ID, "worker", task.RoleOwner, nil); err != nil {
					t.Fatalf("withdrawn task could not be reassigned: %v", err)
				}
			}
		})
	}
}
