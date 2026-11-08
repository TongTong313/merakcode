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

func TestHumanReviewRejectsReworkAfterApprovalAndIgnoresWithdrawnClaims(t *testing.T) {
	for _, approved := range []bool{false, true} {
		name := "withdrawn claim does not block rework"
		if approved {
			name = "approval cannot be replaced during integration"
		}
		t.Run(name, func(t *testing.T) {
			ctx := context.Background()
			storage := memory.New()
			bus := event.NewBus(storage, time.Now, event.NewID)
			groups := group.New(storage, bus, event.NewID)
			g, err := groups.Create(ctx, group.Group{Kind: group.KindLocal, Name: "Project", Project: group.Project{Directory: t.TempDir()}, DefaultLeader: "leader"}, []group.Member{
				{ID: "human", Name: "Owner", Kind: group.MemberHuman},
				{ID: "leader", Name: "Leader", Kind: group.MemberAgent, AgentRole: group.AgentLeader},
				{ID: "worker", Name: "Worker", Kind: group.MemberAgent, AgentRole: group.AgentWorker},
			})
			if err != nil {
				t.Fatal(err)
			}
			pool := task.New(storage, bus, event.NewID, groups)
			card, err := pool.Create(ctx, task.Card{Group: g.ID, Title: "Review", Review: true})
			if err != nil {
				t.Fatal(err)
			}
			claim, err := pool.OpenAndAssign(ctx, card.ID, "worker")
			if err != nil {
				t.Fatal(err)
			}
			if !approved {
				if err := pool.Withdraw(ctx, claim.ID, "leader"); err != nil {
					t.Fatal(err)
				}
				if _, err := pool.Assign(ctx, card.ID, "worker", task.RoleOwner, nil); err != nil {
					t.Fatal(err)
				}
			}
			claim, err = pool.Next(ctx, "worker")
			if err != nil {
				t.Fatal(err)
			}
			if err := pool.Submit(ctx, task.Report{Claim: claim.ID, Verdict: task.VerdictDone, Summary: "Ready"}); err != nil {
				t.Fatal(err)
			}
			if approved {
				if err := pool.Review(ctx, card.ID, task.ReviewResult{Human: "human", Decision: "approve"}); err != nil {
					t.Fatal(err)
				}
			}
			err = pool.Review(ctx, card.ID, task.ReviewResult{Human: "human", Decision: "rework", Feedback: "Revise"})
			if (err != nil) != approved {
				t.Fatalf("approved=%v err=%v", approved, err)
			}
		})
	}
}
