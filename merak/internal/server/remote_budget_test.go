package server_test

import (
	"context"
	"errors"
	"fmt"
	"testing"
	"time"

	"github.com/TongTong313/merakcode/merak/engine"
	"github.com/TongTong313/merakcode/merak/engine/event"
	"github.com/TongTong313/merakcode/merak/engine/group"
	"github.com/TongTong313/merakcode/merak/engine/loop"
	"github.com/TongTong313/merakcode/merak/engine/model"
	"github.com/TongTong313/merakcode/merak/engine/model/fake"
	"github.com/TongTong313/merakcode/merak/engine/profile"
	"github.com/TongTong313/merakcode/merak/engine/task"
	"github.com/TongTong313/merakcode/merak/engine/worker"
	"github.com/TongTong313/merakcode/merak/internal/server"
	"github.com/TongTong313/merakcode/merak/protocol"
)

func TestRemoteBudgetBlocksHostAndIncludesPriorTaskUsage(t *testing.T) {
	for _, prior := range []int{0, 60, -1} {
		t.Run(fmt.Sprint(prior), func(t *testing.T) {
			ctx, cancel := context.WithTimeout(t.Context(), 12*time.Second)
			defer cancel()
			b, err := engine.New(engine.Deps{Workdir: t.TempDir(), Providers: map[string]model.Provider{"fake": fake.New(t, fake.Reply{Text: "Remote work", Usage: &model.Usage{Input: 60}}, fake.Reply{Hold: make(chan struct{})})}})
			if err != nil {
				t.Fatal(err)
			}
			defer b.Close()
			source := profile.DefaultWorker()
			source.ID, source.Model.Provider = "source-profile", "fake"
			if prior < 0 {
				source.Budget.MaxWallClock = time.Second
			}
			if _, err := b.SaveProfile(ctx, "owner", source); err != nil {
				t.Fatal(err)
			}
			if _, err := b.Groups.Create(ctx, group.Group{ID: "source", Kind: group.KindLocal, Name: "Source", DefaultLeader: "leader", Project: group.Project{Directory: t.TempDir()}}, []group.Member{{ID: "leader", Name: "Leader", Kind: group.MemberAgent, AgentRole: group.AgentLeader, Profile: "builtin-leader"}, {ID: "worker", Name: "Worker", Kind: group.MemberAgent, AgentRole: group.AgentWorker, Profile: source.ID}}); err != nil {
				t.Fatal(err)
			}
			peer, err := server.Start(b, t.TempDir())
			if err != nil {
				t.Fatal(err)
			}
			defer peer.Close()
			a, err := engine.New(engine.Deps{DataDir: t.TempDir(), Workdir: t.TempDir(), Providers: map[string]model.Provider{"local": fake.New(t, fake.Reply{Text: "Local work", Usage: &model.Usage{Input: prior}})}})
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
			var connection protocol.RemoteConnection
			if err := client.Call(ctx, "remote.connect", protocol.RemoteConnectParams{Endpoint: peer.Info.Endpoint, Token: peer.Info.Token}, &connection); err != nil {
				t.Fatal(err)
			}
			p := profile.DefaultWorker()
			p.ID = "remote-profile"
			p.Product = &profile.Product{Kind: worker.KindRemote, Remote: &profile.RemoteSource{Connection: connection.ID, Group: "source", Member: "worker"}}
			if _, err := a.SaveProfile(ctx, "owner", p); err != nil {
				t.Fatal(err)
			}
			g, err := a.Groups.Create(ctx, group.Group{Kind: group.KindLocal, Name: "Host", DefaultLeader: "leader", Project: group.Project{Directory: t.TempDir()}}, []group.Member{{ID: "leader", Name: "Leader", Kind: group.MemberAgent, AgentRole: group.AgentLeader, Profile: "builtin-leader"}, {ID: "remote", Name: "Remote", Kind: group.MemberAgent, AgentRole: group.AgentWorker, Profile: p.ID, Remote: true}, {ID: "local", Name: "Local", Kind: group.MemberAgent, AgentRole: group.AgentWorker}, {ID: "owner", Name: "Owner", Kind: group.MemberHuman, Role: group.RoleOwner}})
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
			card, err := a.Tasks.Create(ctx, task.Card{Group: g.ID, Title: "Bounded remote task", Workspace: "none", Budget: task.Budget{MaxTokens: limit}})
			if err != nil {
				t.Fatal(err)
			}
			if prior > 0 {
				local := profile.DefaultWorker()
				local.Model.Provider = "local"
				run, err := a.StartWorker(ctx, local, worker.Assignment{Session: "prior", Claim: task.Claim{Member: "local"}, Scope: event.Scope{Group: g.ID, Task: card.ID}, Workdir: t.TempDir(), Packet: "Start"})
				if err != nil {
					t.Fatal(err)
				}
				if _, err := run.Wait(ctx); err != nil {
					t.Fatal(err)
				}
			}
			if _, err := a.Tasks.OpenAndAssign(ctx, card.ID, "remote"); err != nil {
				t.Fatal(err)
			}
			claim, err := a.Tasks.Next(ctx, "remote")
			if err != nil {
				t.Fatal(err)
			}
			started, stop := b.Bus.Subscribe(event.Filter{Scope: event.Scope{Session: claim.Session}, Types: []event.Type{loop.TurnStarted}})
			defer stop()
			run, err := a.StartWorker(ctx, p, worker.Assignment{Session: claim.Session, Claim: claim, Scope: event.Scope{Group: g.ID, Task: card.ID}, Packet: "Report"})
			if err != nil {
				t.Fatal(err)
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
				if report, err := run.Wait(wait); !errors.Is(err, context.DeadlineExceeded) {
					t.Fatalf("remote grant did not extend execution: %+v %v", report, err)
				}
				_ = run.Cancel(ctx)
				_, _ = run.Wait(ctx)
				return
			}
			report, err := run.Wait(ctx)
			if err != nil || report.Verdict != task.VerdictBlocked {
				t.Fatalf("report=%+v %v", report, err)
			}
			current, err := a.Tasks.Get(ctx, card.ID)
			if err != nil || current.Status != task.Blocked {
				t.Fatalf("host status=%s %v", current.Status, err)
			}
		})
	}
}
