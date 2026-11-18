package feature_test

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"testing"
	"time"

	"github.com/TongTong313/merakcode/merak/engine"
	"github.com/TongTong313/merakcode/merak/engine/agent/definition"
	"github.com/TongTong313/merakcode/merak/engine/agent/loop"
	"github.com/TongTong313/merakcode/merak/engine/agent/model"
	"github.com/TongTong313/merakcode/merak/engine/agent/model/fake"
	"github.com/TongTong313/merakcode/merak/engine/collab/group"
	"github.com/TongTong313/merakcode/merak/engine/infra/event"
	"github.com/TongTong313/merakcode/merak/testkit/enginetest"
)

func TestLeaderCanWriteAndListSharedDocuments(t *testing.T) {
	ctx, cancel := context.WithTimeout(t.Context(), 8*time.Second)
	defer cancel()
	listed := enginetest.IntegrationCall("read_doc", map[string]any{"key": "design"})
	listed.Expect = func(req model.Request) error {
		body, _ := json.Marshal(req.Messages[len(req.Messages)-1])
		if !strings.Contains(string(body), "Design") {
			return fmt.Errorf("document catalog omitted the saved title")
		}
		return nil
	}
	provider := fake.New(t, enginetest.IntegrationCall("write_doc", map[string]any{"key": "design", "title": "Design", "text": "Shared decision", "rev": 0}), enginetest.IntegrationCall("list_docs", map[string]any{}), listed, fake.Reply{Text: "Recorded"})
	dir := t.TempDir()
	deps := enginetest.Deps(t)
	deps.Workdir = dir
	deps.Providers = map[string]model.Provider{"fake": provider}
	e, err := engine.New(deps)
	if err != nil {
		t.Fatal(err)
	}
	defer e.Close()
	p := definition.DefaultMerakCode()
	p.ID, p.Model.Provider = "leader-profile", "fake"
	g, err := enginetest.CreateGroup(t, e, ctx, group.Group{Kind: group.KindLocal, Name: "Docs", Project: group.Project{Directory: dir}, Leader: "leader"}, []group.Member{{ID: "owner", Name: "Owner", Kind: group.MemberHuman, Role: "owner"}, {ID: "leader", Name: "Leader", Kind: group.MemberAgent, AgentRole: group.AgentLeader, Agent: p.ID}}, []definition.Agent{p})
	if err != nil {
		t.Fatal(err)
	}
	events, stop := e.Subscribe(event.Filter{Scope: event.Scope{Group: g.ID}, Types: []event.Type{loop.TurnFinished}})
	defer stop()
	if _, err := e.SayGroup(ctx, g.ID, "", "owner", group.Message{Text: "Record the shared design"}); err != nil {
		t.Fatal(err)
	}
	select {
	case <-events:
	case <-ctx.Done():
		t.Fatal(ctx.Err())
	}
	doc, err := e.ReadGroupDocument(ctx, g.ID, "design")
	if err != nil || doc.Text != "Shared decision" || doc.Rev != 1 {
		t.Fatalf("document=%+v %v", doc, err)
	}
}
