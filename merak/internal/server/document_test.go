package server_test

import (
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/TongTong313/merakcode/merak/engine"
	"github.com/TongTong313/merakcode/merak/engine/group"
	"github.com/TongTong313/merakcode/merak/internal/server"
	"github.com/TongTong313/merakcode/merak/protocol"
)

func TestSharedDocumentsAreVersionedAndCheckTheWriterRole(t *testing.T) {
	ctx := t.Context()
	e, err := engine.New(engine.Deps{})
	if err != nil {
		t.Fatal(err)
	}
	handler := server.New(e, "token")
	defer handler.Close()
	host := httptest.NewServer(handler)
	defer host.Close()
	client, err := protocol.Connect(ctx, "ws"+strings.TrimPrefix(host.URL, "http"), "token", protocol.HelloParams{Protocol: 1})
	if err != nil {
		t.Fatal(err)
	}
	defer client.Close()
	g, err := e.Groups.Create(ctx, group.Group{Kind: group.KindLocal, Name: "Documents", Project: group.Project{Directory: t.TempDir()}, DefaultLeader: "leader"}, []group.Member{
		{ID: "leader", Name: "Leader", Kind: group.MemberAgent, AgentRole: group.AgentLeader},
		{ID: "member", Name: "Member", Kind: group.MemberHuman, Role: "member"},
		{ID: "observer", Name: "Observer", Kind: group.MemberHuman, Role: "observer"},
	})
	if err != nil {
		t.Fatal(err)
	}
	params := map[string]any{"group": g.ID, "human": "member", "key": "design", "title": "Design", "text": "First version", "rev": 0}
	var result struct {
		Group string
		Key   string
		Text  string
		Rev   uint64
	}
	if err := client.Call(ctx, "doc.write", params, &result); err != nil {
		t.Fatal(err)
	}
	if result.Rev != 1 || result.Text != "First version" {
		t.Fatalf("document=%+v", result)
	}
	params["text"] = "Lost update"
	if err := client.Call(ctx, "doc.write", params, &result); err == nil {
		t.Fatal("stale revision overwrote a document")
	}
	params["rev"], params["human"] = 1, "observer"
	if err := client.Call(ctx, "doc.write", params, &result); err == nil {
		t.Fatal("observer wrote a document")
	}
	params["human"], params["text"] = "member", "Second version"
	if err := client.Call(ctx, "doc.write", params, &result); err != nil || result.Rev != 2 {
		t.Fatalf("update=%+v %v", result, err)
	}
	if err := client.Call(ctx, "doc.read", map[string]any{"group": g.ID, "key": "design"}, &result); err != nil || result.Text != "Second version" {
		t.Fatalf("read=%+v %v", result, err)
	}
	var list []struct {
		Key, Title string
		Rev        uint64
	}
	if err := client.Call(ctx, "doc.list", map[string]any{"group": g.ID}, &list); err != nil || len(list) != 1 || list[0].Key != "design" || list[0].Rev != 2 {
		t.Fatalf("list=%+v %v", list, err)
	}
}
