package server_test

import (
	"context"
	"errors"
	"fmt"
	"testing"
	"time"

	"github.com/TongTong313/merakcode/merak/cloudlink"
	"github.com/TongTong313/merakcode/merak/engine"
	"github.com/TongTong313/merakcode/merak/engine/agent/definition"
	"github.com/TongTong313/merakcode/merak/engine/agent/loop"
	"github.com/TongTong313/merakcode/merak/engine/agent/model"
	"github.com/TongTong313/merakcode/merak/engine/agent/model/fake"
	"github.com/TongTong313/merakcode/merak/engine/collab/group"
	"github.com/TongTong313/merakcode/merak/engine/collab/task"
	"github.com/TongTong313/merakcode/merak/engine/collab/wire"
	"github.com/TongTong313/merakcode/merak/engine/collab/worker"
	"github.com/TongTong313/merakcode/merak/engine/infra/event"
	"github.com/TongTong313/merakcode/merak/protocol"
	"github.com/TongTong313/merakcode/merak/server"
	"github.com/TongTong313/merakcode/merak/testkit/enginetest"
)

func TestRemoteBudgetBlocksHostAndIncludesPriorTaskUsage(t *testing.T) {
	for _, prior := range []int{0, 60, -1} {
		t.Run(fmt.Sprint(prior), func(t *testing.T) {
			ctx, cancel := context.WithTimeout(t.Context(), 12*time.Second)
			defer cancel()
			deps := enginetest.Deps(t)
			deps.Dial = cloudlink.Dial
			deps.Workdir = t.TempDir()
			deps.Providers = map[string]model.Provider{"fake": fake.New(t, fake.Reply{Text: "Remote work", Usage: &model.Usage{Input: 60}}, fake.Reply{Hold: make(chan struct{})})}
			b, err := engine.New(deps)
			if err != nil {
				t.Fatal(err)
			}
			defer b.Close()
			source := definition.DefaultMerakCode()
			source.ID, source.Model.Provider = "source-profile", "fake"
			if prior < 0 {
				source.Budget.MaxWallClock = time.Second
			}
			if _, err := b.SaveAgent(ctx, "owner", source); err != nil {
				t.Fatal(err)
			}
			if _, err := b.CreateGroup(ctx, group.Group{ID: "source", Kind: group.KindLocal, Name: "Source", Leader: "leader", Project: group.Project{Directory: t.TempDir()}}, []group.Member{{ID: "leader", Name: "Leader", Kind: group.MemberAgent, AgentRole: group.AgentLeader, Agent: "builtin-merakcode"}, {ID: "worker", Name: "Worker", Kind: group.MemberAgent, AgentRole: group.AgentWorker, Agent: source.ID}}); err != nil {
				t.Fatal(err)
			}
			peer, err := server.Start(b, t.TempDir())
			if err != nil {
				t.Fatal(err)
			}
			defer peer.Close()
			deps2 := enginetest.Deps(t)
			deps2.Dial = cloudlink.Dial
			deps2.DataDir = t.TempDir()
			deps2.Dirs = enginetest.Dirs(t, deps2.DataDir)
			deps2.Workdir = t.TempDir()
			deps2.Providers = map[string]model.Provider{"local": fake.New(t, fake.Reply{Text: "Local work", Usage: &model.Usage{Input: prior}}), "leader": fake.New(t, fake.Reply{Hold: make(chan struct{})})}
			a, err := engine.New(deps2)
			if err != nil {
				t.Fatal(err)
			}
			defer a.Close()
			host, err := server.Start(a, t.TempDir())
			if err != nil {
				t.Fatal(err)
			}
			defer host.Close()
			client, err := protocol.Connect(ctx, host.Info.Endpoint, host.Info.Token, protocol.HelloParams{Protocol: 1})
			if err != nil {
				t.Fatal(err)
			}
			defer client.Close()
			var connection wire.RemoteConnection
			if err := client.Call(ctx, "remote.connect", wire.RemoteConnectParams{Endpoint: peer.Info.Endpoint, Token: peer.Info.Token}, &connection); err != nil {
				t.Fatal(err)
			}
			p := definition.DefaultMerakCode()
			p.ID = "remote-profile"
			p.Product = &definition.Product{Kind: definition.KindRemote, Remote: &definition.RemoteSource{Connection: connection.ID, Group: "source", Member: "worker"}}
			if _, err := a.SaveAgent(ctx, "owner", p); err != nil {
				t.Fatal(err)
			}
			lead := definition.DefaultMerakCode()
			lead.ID, lead.Model.Provider = "leader-profile", "leader"
			if _, err := a.SaveAgent(ctx, "owner", lead); err != nil {
				t.Fatal(err)
			}
			g, err := a.CreateGroup(ctx, group.Group{Kind: group.KindLocal, Name: "Host", Leader: "leader", Project: group.Project{Directory: t.TempDir()}}, []group.Member{{ID: "leader", Name: "Leader", Kind: group.MemberAgent, AgentRole: group.AgentLeader, Agent: lead.ID}, {ID: "remote", Name: "Remote", Kind: group.MemberAgent, AgentRole: group.AgentWorker, Agent: p.ID, Remote: true}, {ID: "local", Name: "Local", Kind: group.MemberAgent, AgentRole: group.AgentWorker}, {ID: "owner", Name: "Owner", Kind: group.MemberHuman, Role: group.RoleOwner}})
			if err != nil {
				t.Fatal(err)
			}
			limit := 10
			if prior > 0 {
				limit = 100
			}
			if prior < 0 {
				limit = 0
			}
			card, err := a.CreateTask(ctx, task.Card{Group: g.ID, Title: "Bounded remote task", Workspace: "none", Budget: task.Budget{MaxTokens: limit}})
			if err != nil {
				t.Fatal(err)
			}
			if prior > 0 {
				local := definition.DefaultMerakCode()
				local.Model.Provider = "local"
				run, err := a.StartWorker(ctx, local, worker.Assignment{Session: "prior", Claim: task.Claim{Member: "local"}, Scope: event.Scope{Group: g.ID, Task: card.ID}, Workdir: t.TempDir(), Packet: "Start"})
				if err != nil {
					t.Fatal(err)
				}
				if _, err := run.Wait(ctx); err != nil {
					t.Fatal(err)
				}
			}
			started, stop := b.Subscribe(event.Filter{Scope: event.Scope{Group: g.ID, Task: card.ID}, Types: []event.Type{loop.TurnStarted}})
			defer stop()
			reports, stopReports := a.Subscribe(event.Filter{Scope: event.Scope{Group: g.ID, Task: card.ID}, Types: []event.Type{task.Reported}})
			defer stopReports()
			claim, err := a.AssignTask(ctx, card.ID, "owner", "remote", task.RoleOwner, nil)
			if err != nil {
				t.Fatal(err)
			}
			waitReport := func(wait context.Context) (task.Report, error) {
				select {
				case fact := <-reports:
					current, err := event.Decode[task.Card](fact)
					if err != nil {
						return task.Report{}, err
					}
					for _, reported := range current.Claims {
						if reported.ID == claim.ID && reported.Report != nil {
							return *reported.Report, nil
						}
					}
					return task.Report{}, errors.New("remote claim has no report")
				case <-wait.Done():
					return task.Report{}, wait.Err()
				}
			}
			if prior < 0 {
				select {
				case <-started:
				case <-ctx.Done():
					t.Fatal(ctx.Err())
				}
				if err := a.UpdateTask(ctx, card.ID, task.Update{Budget: &task.BudgetIncrease{WallClock: 3 * time.Second}}, event.Actor{Kind: event.ActorHuman, ID: "owner"}); err != nil {
					t.Fatal(err)
				}
				wait, done := context.WithTimeout(ctx, 1500*time.Millisecond)
				defer done()
				if report, err := waitReport(wait); !errors.Is(err, context.DeadlineExceeded) {
					t.Fatalf("remote grant did not extend execution: %+v %v", report, err)
				}
				_ = a.Close()
				return
			}
			report, err := waitReport(ctx)
			if err != nil || report.Verdict != task.VerdictBlocked {
				t.Fatalf("report=%+v %v", report, err)
			}
			current, err := a.Task(ctx, card.ID)
			if err != nil || current.Status != task.Blocked {
				t.Fatalf("host status=%s %v", current.Status, err)
			}
		})
	}
}
