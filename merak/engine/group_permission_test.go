package engine_test

import (
	"context"
	"encoding/json"
	"fmt"
	"regexp"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/TongTong313/merakcode/merak/engine"
	"github.com/TongTong313/merakcode/merak/engine/event"
	"github.com/TongTong313/merakcode/merak/engine/group"
	"github.com/TongTong313/merakcode/merak/engine/model"
	"github.com/TongTong313/merakcode/merak/engine/model/fake"
	"github.com/TongTong313/merakcode/merak/engine/permission"
	"github.com/TongTong313/merakcode/merak/engine/profile"
	"github.com/TongTong313/merakcode/merak/engine/task"
)

func TestLeaderApprovalToolsResolveWorkerRequests(t *testing.T) {
	for _, escalate := range []bool{false, true} {
		t.Run(fmt.Sprintf("escalate=%t", escalate), func(t *testing.T) {
			ctx, cancel := context.WithTimeout(t.Context(), 15*time.Second)
			defer cancel()
			directory := t.TempDir()
			var asked atomic.Int32
			expression := regexp.MustCompile(`(?s)\(permission.routed\).*?"id":"([^"]+)"`)
			leadModel := groupScript{name: "leader", test: t, reply: func(req model.Request) fake.Reply {
				var text strings.Builder
				for _, part := range req.Messages[len(req.Messages)-1].Parts {
					text.WriteString(part.Text)
				}
				match := expression.FindStringSubmatch(text.String())
				if len(match) != 2 {
					return fake.Reply{Text: "Waiting."}
				}
				if escalate {
					return integrationCall("ask_human", map[string]any{"request": match[1]})
				}
				return integrationCall("approve", map[string]any{"request": match[1], "decision": "allow"})
			}}
			report := integrationCall("submit_report", map[string]any{"verdict": "done", "summary": "Approved command completed."})
			report.Expect = func(req model.Request) error {
				body, _ := json.Marshal(req.Messages)
				if !strings.Contains(string(body), "approved") {
					return fmt.Errorf("worker did not receive command output")
				}
				return nil
			}
			e, err := engine.New(engine.Deps{Workdir: directory, Providers: map[string]model.Provider{"leader": leadModel, "worker": fake.New(t, integrationCall("bash", map[string]any{"command": "echo approved"}), report)}, Ask: func(context.Context, permission.Request) (permission.Reply, error) {
				asked.Add(1)
				return permission.Reply{Decision: permission.Allow, Human: "approver"}, nil
			}})
			if err != nil {
				t.Fatal(err)
			}
			defer e.Close()
			status, err := e.SandboxStatus(ctx, directory, permission.ModeAuto)
			if err != nil {
				t.Fatal(err)
			}
			if !status.Available {
				t.Skip("enforced sandbox is unavailable")
			}
			lead, work := profile.DefaultLeader(), profile.DefaultWorker()
			lead.ID, lead.Model.Provider = "leader-profile", "leader"
			work.ID, work.Model.Provider, work.Mode = "worker-profile", "worker", permission.ModeAuto
			g, err := e.CreateGroup(ctx, group.Group{Kind: group.KindLocal, Name: "Team", Project: group.Project{Directory: directory}, DefaultLeader: "leader"}, []group.Member{
				{ID: "leader", Name: "Leader", Kind: group.MemberAgent, AgentRole: group.AgentLeader, Profile: lead.ID},
				{ID: "worker", Name: "Worker", Kind: group.MemberAgent, AgentRole: group.AgentWorker, Profile: work.ID},
				{ID: "approver", Name: "Approver", Kind: group.MemberHuman, Role: group.RoleApprover},
				{ID: "owner", Name: "Owner", Kind: group.MemberHuman, Role: group.RoleOwner},
			}, []profile.Profile{lead, work})
			if err != nil {
				t.Fatal(err)
			}
			facts, stop := e.Bus.Subscribe(event.Filter{Scope: event.Scope{Group: g.ID}, Types: []event.Type{task.Reported}})
			defer stop()
			if _, err := e.CreateAssignedTask(ctx, task.Card{Group: g.ID, Title: "Verify", Participants: []event.ID{"approver"}, CreatedBy: event.Actor{Kind: event.ActorHuman, ID: "owner"}}, "worker"); err != nil {
				t.Fatal(err)
			}
			select {
			case fact := <-facts:
				card, err := event.Decode[task.Card](fact)
				if err != nil || card.Claims[0].Report.Verdict != task.VerdictDone {
					t.Fatalf("card=%+v err=%v", card, err)
				}
				want := int32(0)
				if escalate {
					want = 1
				}
				if asked.Load() != want {
					t.Fatalf("human approvals=%d want=%d", asked.Load(), want)
				}
			case <-ctx.Done():
				t.Fatal("Leader approval did not resume Worker")
			}
		})
	}
}
