package task_test

import (
	"testing"
	"time"

	"github.com/TongTong313/merakcode/merak/engine/event"
	"github.com/TongTong313/merakcode/merak/engine/group"
	"github.com/TongTong313/merakcode/merak/engine/store/memory"
	"github.com/TongTong313/merakcode/merak/engine/task"
)

func TestBudgetGrantPreservesEveryMembersClaimSession(t *testing.T) {
	for _, tc := range []struct {
		name                     string
		collaboratorFirst, relay bool
	}{
		{"owner first", false, false}, {"collaborator first", true, false},
		{"relay owner first", false, true}, {"relay collaborator first", true, true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			ctx := t.Context()
			storage := memory.New()
			bus := event.NewBus(storage, time.Now, event.NewID)
			groups := group.New(storage, bus, event.NewID)
			g, err := groups.Create(ctx, group.Group{Kind: group.KindLocal, Name: "Budget", DefaultLeader: "leader", Project: group.Project{Directory: t.TempDir()}}, []group.Member{
				{ID: "owner", Name: "Owner", Kind: group.MemberHuman, Role: group.RoleOwner},
				{ID: "leader", Name: "Leader", Kind: group.MemberAgent, AgentRole: group.AgentLeader},
				{ID: "first", Name: "First", Kind: group.MemberAgent, AgentRole: group.AgentWorker},
				{ID: "second", Name: "Second", Kind: group.MemberAgent, AgentRole: group.AgentWorker},
				{ID: "third", Name: "Third", Kind: group.MemberAgent, AgentRole: group.AgentWorker},
			})
			if err != nil {
				t.Fatal(err)
			}
			pool := task.New(storage, bus, event.NewID, groups)
			card, err := pool.Create(ctx, task.Card{Group: g.ID, Title: "Shared task", Workspace: "none", Areas: []string{"a", "b"}})
			if err != nil {
				t.Fatal(err)
			}
			if err := pool.Open(ctx, card.ID); err != nil {
				t.Fatal(err)
			}
			if _, err := pool.Assign(ctx, card.ID, "first", task.RoleOwner, []string{"a"}); err != nil {
				t.Fatal(err)
			}
			if _, err := pool.Assign(ctx, card.ID, "second", task.RoleCollaborator, []string{"b"}); err != nil {
				t.Fatal(err)
			}
			var claims []task.Claim
			for _, member := range []event.ID{"first", "second"} {
				claim, err := pool.Next(ctx, member)
				if err != nil {
					t.Fatal(err)
				}
				claims = append(claims, claim)
			}
			if err := pool.Block(ctx, card.ID); err != nil {
				t.Fatal(err)
			}
			for _, claim := range claims {
				if err := pool.Submit(ctx, task.Report{Claim: claim.ID, Verdict: task.VerdictBlocked, Summary: "Budget exhausted"}); err != nil {
					t.Fatal(err)
				}
			}
			if err := pool.Update(ctx, card.ID, task.Update{Budget: &task.BudgetIncrease{Tokens: 100}}, event.Actor{Kind: event.ActorHuman, ID: "owner"}); err != nil {
				t.Fatal(err)
			}
			if tc.collaboratorFirst {
				claims[0], claims[1] = claims[1], claims[0]
			}
			for _, previous := range claims {
				if tc.relay && previous.Role == task.RoleOwner {
					claim, err := pool.Assign(ctx, card.ID, "third", task.RoleOwner, previous.Scope)
					if err != nil {
						t.Fatalf("relay owner: %v", err)
					}
					active, err := pool.Next(ctx, "third")
					if err != nil || active.ID != claim.ID || active.ID == previous.ID || active.Session == previous.Session {
						t.Fatalf("relay=%+v %v", active, err)
					}
					continue
				}
				if _, err := pool.Assign(ctx, card.ID, previous.Member, previous.Role, []string{"different"}); err == nil {
					t.Fatal("resumed claim changed its scope")
				}
				claim, err := pool.Assign(ctx, card.ID, previous.Member, previous.Role, nil)
				if err != nil {
					t.Fatalf("resume %s: %v", previous.Role, err)
				}
				if claim.ID != previous.ID || claim.Session != previous.Session || len(claim.Scope) != 1 || claim.Scope[0] != previous.Scope[0] {
					t.Fatalf("changed claim: %+v", claim)
				}
				active, err := pool.Next(ctx, previous.Member)
				if err != nil || active.ID != previous.ID || active.Session != previous.Session {
					t.Fatalf("next=%+v %v", active, err)
				}
			}
		})
	}
}
