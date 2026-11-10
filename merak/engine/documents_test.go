package engine_test

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"testing"
	"time"

	"github.com/TongTong313/merakcode/merak/engine"
	"github.com/TongTong313/merakcode/merak/engine/event"
	"github.com/TongTong313/merakcode/merak/engine/group"
	"github.com/TongTong313/merakcode/merak/engine/loop"
	"github.com/TongTong313/merakcode/merak/engine/model"
	"github.com/TongTong313/merakcode/merak/engine/model/fake"
	"github.com/TongTong313/merakcode/merak/engine/profile"
)

func TestLeaderCanWriteAndListSharedDocuments(t *testing.T) {
	ctx, cancel := context.WithTimeout(t.Context(), 8*time.Second)
	defer cancel()
	listed := integrationCall("read_doc", map[string]any{"key": "design"})
	listed.Expect = func(req model.Request) error {
		body, _ := json.Marshal(req.Messages[len(req.Messages)-1])
		if !strings.Contains(string(body), "Design") {
			return fmt.Errorf("document catalog omitted the saved title")
		}
		return nil
	}
	provider := fake.New(t, integrationCall("write_doc", map[string]any{"key": "design", "title": "Design", "text": "Shared decision", "rev": 0}), integrationCall("list_docs", map[string]any{}), listed, fake.Reply{Text: "Recorded"})
	dir := t.TempDir()
	e, err := engine.New(engine.Deps{Workdir: dir, Providers: map[string]model.Provider{"fake": provider}})
	if err != nil {
		t.Fatal(err)
	}
	defer e.Close()
	p := profile.DefaultLeader()
	p.ID, p.Model.Provider = "leader-profile", "fake"
	g, err := e.CreateGroup(ctx, group.Group{Kind: group.KindLocal, Name: "Docs", Project: group.Project{Directory: dir}, DefaultLeader: "leader"}, []group.Member{{ID: "owner", Name: "Owner", Kind: group.MemberHuman, Role: "owner"}, {ID: "leader", Name: "Leader", Kind: group.MemberAgent, AgentRole: group.AgentLeader, Profile: p.ID}}, []profile.Profile{p})
	if err != nil {
		t.Fatal(err)
	}
	events, stop := e.Bus.Subscribe(event.Filter{Scope: event.Scope{Group: g.ID}, Types: []event.Type{loop.TurnFinished}})
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
