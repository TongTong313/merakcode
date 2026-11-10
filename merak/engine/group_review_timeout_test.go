package engine_test

import (
	"context"
	"testing"
	"time"

	"github.com/TongTong313/merakcode/merak/engine"
	"github.com/TongTong313/merakcode/merak/engine/event"
	"github.com/TongTong313/merakcode/merak/engine/group"
	"github.com/TongTong313/merakcode/merak/engine/model"
	"github.com/TongTong313/merakcode/merak/engine/model/fake"
	"github.com/TongTong313/merakcode/merak/engine/profile"
	"github.com/TongTong313/merakcode/merak/engine/store/memory"
	"github.com/TongTong313/merakcode/merak/engine/task"
)

func TestRecoverKeepsOriginalPlanAndReviewDeadlines(t *testing.T) {
	for _, kind := range []string{"plan", "review"} {
		t.Run(kind, func(t *testing.T) {
			ctx, cancel := context.WithTimeout(t.Context(), 3*time.Second)
			defer cancel()
			storage := memory.New()
			bus := event.NewBus(storage, func() time.Time { return time.Now().Add(-time.Minute) }, event.NewID)
			groups := group.New(storage, bus, event.NewID)
			g, err := groups.Create(ctx, group.Group{Kind: group.KindLocal, Name: "Recover approval", Project: group.Project{Directory: t.TempDir()}, DefaultLeader: "leader", Settings: group.Settings{PlanNeedsApproval: kind == "plan", ApprovalTimeout: time.Second}}, []group.Member{{ID: "leader", Name: "Leader", Kind: group.MemberAgent, AgentRole: group.AgentLeader, Profile: "builtin-leader"}, {ID: "worker", Name: "Worker", Kind: group.MemberAgent, AgentRole: group.AgentWorker, Profile: "builtin-worker"}, {ID: "owner", Name: "Owner", Kind: group.MemberHuman, Role: group.RoleOwner}})
			if err != nil {
				t.Fatal(err)
			}
			pool := task.New(storage, bus, event.NewID, groups)
			card, err := pool.Create(ctx, task.Card{Group: g.ID, Title: "Pending approval"})
			if err != nil {
				t.Fatal(err)
			}
			if kind == "review" {
				if _, err = pool.OpenAndAssign(ctx, card.ID, "worker"); err != nil {
					t.Fatal(err)
				}
				claim, err := pool.Next(ctx, "worker")
				if err != nil {
					t.Fatal(err)
				}
				if err = pool.Submit(ctx, task.Report{Claim: claim.ID, Verdict: task.VerdictDone, Summary: "Complete"}); err != nil {
					t.Fatal(err)
				}
			} else if err = pool.Open(ctx, card.ID); err != nil {
				t.Fatal(err)
			}
			phases := []task.Phase{task.PhaseDoing}
			if kind == "review" {
				phases = append(phases, task.PhaseIntegrating, task.PhaseReview)
			}
			for _, phase := range phases {
				if err = pool.SetPhase(ctx, card.ID, phase, event.Actor{Kind: event.ActorAgent, ID: "leader"}); err != nil {
					t.Fatal(err)
				}
			}
			e, err := engine.New(engine.Deps{Store: storage})
			if err != nil {
				t.Fatal(err)
			}
			defer e.Close()
			facts, stop := e.Bus.Subscribe(event.Filter{Scope: event.Scope{Group: g.ID}, Types: []event.Type{engine.SentinelFlagged}})
			defer stop()
			if err = e.Recover(ctx); err != nil {
				t.Fatal(err)
			}
			select {
			case <-facts:
				card, err = e.Tasks.Get(ctx, card.ID)
				if err != nil || card.Status != task.Blocked {
					t.Fatalf("card=%+v err=%v", card, err)
				}
			case <-ctx.Done():
				t.Fatal("recovery lost the original deadline")
			}
		})
	}
}

func TestRealPlanAndReviewRequestsTimeOutToBlockedTasks(t *testing.T) {
	for _, kind := range []string{"plan", "review"} {
		t.Run(kind, func(t *testing.T) {
			ctx, cancel := context.WithTimeout(t.Context(), 5*time.Second)
			defer cancel()
			directory := t.TempDir()
			provider := groupScript{name: "leader", test: t, reply: func(model.Request) fake.Reply { return fake.Reply{Text: "Waiting for a human."} }}
			e, err := engine.New(engine.Deps{Workdir: directory, ApprovalTimeout: 300 * time.Millisecond, Providers: map[string]model.Provider{"leader": provider, "worker": fake.New(t, integrationCall("submit_report", map[string]any{"verdict": "done", "summary": "Ready for review."}))}})
			if err != nil {
				t.Fatal(err)
			}
			defer e.Close()
			lead := profile.DefaultLeader()
			lead.ID, lead.Model.Provider = "leader-profile", "leader"
			work := profile.DefaultWorker()
			work.ID, work.Model.Provider = "worker-profile", "worker"
			g, err := e.CreateGroup(ctx, group.Group{Kind: group.KindLocal, Name: "Team", Project: group.Project{Directory: directory}, DefaultLeader: "leader", Settings: group.Settings{PlanNeedsApproval: kind == "plan", Review: new(true)}}, []group.Member{
				{ID: "leader", Name: "Leader", Kind: group.MemberAgent, AgentRole: group.AgentLeader, Profile: lead.ID},
				{ID: "worker", Name: "Worker", Kind: group.MemberAgent, AgentRole: group.AgentWorker, Profile: work.ID},
				{ID: "approver", Name: "Approver", Kind: group.MemberHuman, Role: group.RoleApprover},
				{ID: "owner", Name: "Owner", Kind: group.MemberHuman, Role: group.RoleOwner},
			}, []profile.Profile{lead, work})
			if err != nil {
				t.Fatal(err)
			}
			facts, stop := e.Bus.Subscribe(event.Filter{Scope: event.Scope{Group: g.ID}, Types: []event.Type{group.NoticeSent, engine.SentinelFlagged}})
			defer stop()
			reports, stopReports := e.Bus.Subscribe(event.Filter{Scope: event.Scope{Group: g.ID}, Types: []event.Type{task.Reported}})
			defer stopReports()
			input := task.Card{Group: g.ID, Title: "Goal", Review: kind == "review", Participants: []event.ID{"approver"}, CreatedBy: event.Actor{Kind: event.ActorHuman, ID: "owner"}}
			var card task.Card
			if kind == "review" {
				card, err = e.CreateAssignedTask(ctx, input, "worker")
			} else {
				card, err = e.CreateTask(ctx, input)
			}
			if err != nil {
				t.Fatal(err)
			}
			phases := []task.Phase{task.PhaseDoing}
			if kind == "review" {
				select {
				case <-reports:
				case <-ctx.Done():
					t.Fatal("worker did not submit report")
				}
				phases = append(phases, task.PhaseIntegrating, task.PhaseReview)
			}
			for _, phase := range phases {
				if err := e.Tasks.SetPhase(ctx, card.ID, phase, event.Actor{Kind: event.ActorAgent, ID: "leader"}); err != nil {
					t.Fatal(err)
				}
			}
			requested := false
			flagged := false
			for {
				select {
				case fact := <-facts:
					if fact.Type == engine.SentinelFlagged {
						flagged = true
						continue
					}
					notice, err := event.Decode[group.Notice](fact)
					if err != nil {
						t.Fatal(err)
					}
					if notice.Kind == kind {
						requested = true
						if len(notice.To) != 1 || notice.To[0] != "approver" {
							t.Fatalf("participants were not preferred: %+v", notice)
						}
					}
					if notice.Kind != "blocked" {
						continue
					}
					if !requested || !flagged || len(notice.To) != 1 || notice.To[0] != "owner" {
						t.Fatalf("timeout notice=%+v", notice)
					}
					blocked, err := e.Tasks.Get(ctx, card.ID)
					if err != nil || blocked.Status != task.Blocked {
						t.Fatalf("task=%+v err=%v", blocked, err)
					}
					return
				case <-ctx.Done():
					t.Fatal("real human approval did not time out")
				}
			}
		})
	}
}
