package engine_test

import (
	"context"
	"encoding/json"
	"strings"
	"testing"
	"time"

	"github.com/TongTong313/merakcode/merak/engine"
	"github.com/TongTong313/merakcode/merak/engine/event"
	"github.com/TongTong313/merakcode/merak/engine/group"
	"github.com/TongTong313/merakcode/merak/engine/model"
	"github.com/TongTong313/merakcode/merak/engine/model/catalog"
	"github.com/TongTong313/merakcode/merak/engine/model/fake"
	"github.com/TongTong313/merakcode/merak/engine/task"
)

func TestWorkerTaskPacketIsSizedForTheDefaultModelWindow(t *testing.T) {
	for _, tc := range []struct {
		name   string
		window int
		kept   bool
	}{
		{"a large window keeps the dialogue", 200000, true},
		{"a small window drops a long dialogue", 16000, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			ctx, cancel := context.WithTimeout(t.Context(), 10*time.Second)
			defer cancel()
			dir := t.TempDir()
			received := make(chan string, 4)
			provider := groupScript{name: "fake", test: t, reply: func(req model.Request) fake.Reply {
				body, _ := json.Marshal(req.Messages)
				received <- string(body)
				return fake.Reply{Text: "Done"}
			}}
			e, err := engine.New(engine.Deps{Workdir: dir, Providers: map[string]model.Provider{"fake": provider}})
			if err != nil {
				t.Fatal(err)
			}
			defer e.Close()
			window := tc.window
			e.ConfigureModels([]catalog.Override{{Provider: "fake", ID: "default-model", Window: &window}})
			e.SetDefaultModel("fake", "default-model", "")
			g, err := createGroup(t, e, ctx, group.Group{Kind: group.KindLocal, Name: "Sizing", Leader: "leader", Project: group.Project{Directory: dir}}, []group.Member{
				{ID: "owner", Name: "Owner", Kind: group.MemberHuman, Role: group.RoleOwner},
				{ID: "leader", Name: "Leader", Kind: group.MemberAgent, AgentRole: group.AgentLeader, Agent: "builtin-leader"},
				{ID: "worker", Name: "Worker", Kind: group.MemberAgent, AgentRole: group.AgentWorker, Agent: "builtin-worker"},
			}, nil)
			if err != nil {
				t.Fatal(err)
			}
			if _, err := e.SayGroup(ctx, g.ID, "", "owner", group.Message{To: []event.ID{"worker"}, Text: "Marker sentence for the packet " + strings.Repeat("filler ", 3000)}); err != nil {
				t.Fatal(err)
			}
			if _, err := e.CreateAssignedTask(ctx, task.Card{Group: g.ID, Title: "Sizing", Workspace: "none", CreatedBy: event.Actor{Kind: event.ActorHuman, ID: "owner"}}, "worker"); err != nil {
				t.Fatal(err)
			}
			for {
				select {
				case body := <-received:
					if !strings.Contains(body, `\"goal\"`) {
						continue
					}
					if got := strings.Contains(body, "Marker sentence for the packet"); got != tc.kept {
						t.Fatalf("dialogue in the packet = %v, want %v", got, tc.kept)
					}
					return
				case <-ctx.Done():
					t.Fatal("the worker did not start")
				}
			}
		})
	}
}
