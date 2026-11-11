package server_test

import (
	"context"
	"errors"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/TongTong313/merakcode/merak/engine"
	"github.com/TongTong313/merakcode/merak/engine/model"
	"github.com/TongTong313/merakcode/merak/engine/model/fake"
	"github.com/TongTong313/merakcode/merak/engine/permission"
	"github.com/TongTong313/merakcode/merak/engine/session"
	"github.com/TongTong313/merakcode/merak/internal/server"
	"github.com/TongTong313/merakcode/merak/protocol"
)

func TestSessionManagementMethodsListSearchRenameArchiveAndDelete(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	e, err := engine.New(engine.Deps{Workdir: t.TempDir(), Providers: map[string]model.Provider{"fake": fake.New(t, fake.Reply{Text: "Pineapple noted."})}})
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
	var created protocol.SessionCreateResult
	if err := client.Call(ctx, "session.create", protocol.SessionCreateParams{Workdir: t.TempDir(), Provider: "fake"}, &created); err != nil {
		t.Fatal(err)
	}
	if err := client.Call(ctx, "session.send", protocol.SessionSendParams{Session: created.Session, Parts: []model.Part{{Text: "Tell me about pineapple"}}}, nil); err != nil {
		t.Fatal(err)
	}
	var hits []session.Hit
	for len(hits) == 0 && ctx.Err() == nil {
		if err := client.Call(ctx, "session.search", protocol.SessionSearchParams{Query: "pineapple", Limit: 5}, &hits); err != nil {
			t.Fatal(err)
		}
		time.Sleep(10 * time.Millisecond)
	}
	if len(hits) != 1 || hits[0].Session != created.Session {
		t.Fatalf("hits=%+v", hits)
	}

	title, archived := "Fruit", true
	if err := client.Call(ctx, "session.update", protocol.SessionUpdateParams{Session: created.Session, Update: session.Update{Title: &title, Archived: &archived}}, nil); err != nil {
		t.Fatal(err)
	}
	var visible, hidden []session.Info
	if err := client.Call(ctx, "session.list", protocol.SessionListParams{}, &visible); err != nil || len(visible) != 0 {
		t.Fatalf("the default list shows an archived session: %+v %v", visible, err)
	}
	if err := client.Call(ctx, "session.list", protocol.SessionListParams{Archived: true}, &hidden); err != nil || len(hidden) != 1 || hidden[0].Title != title {
		t.Fatalf("the archive list: %+v %v", hidden, err)
	}

	var failure *protocol.Error
	err = client.Call(ctx, "session.update", protocol.SessionUpdateParams{Session: created.Session, Update: session.Update{Mode: permission.ModeTakeover}}, nil)
	if !errors.As(err, &failure) || failure.Data.Code != "MRK-4006" {
		t.Fatalf("takeover without confirmation: %v", err)
	}
	err = client.Call(ctx, "session.revert", protocol.SessionRevertParams{Session: created.Session, Message: "nobody"}, nil)
	if !errors.As(err, &failure) || failure.Data.Code != "MRK-4007" {
		t.Fatalf("revert to a stranger: %v", err)
	}
	err = client.Call(ctx, "session.unrevert", protocol.SessionCancelParams{Session: created.Session}, nil)
	if !errors.As(err, &failure) || failure.Data.Code != "MRK-4008" {
		t.Fatalf("unrevert without a revert: %v", err)
	}
	if err := client.Call(ctx, "session.delete", protocol.SessionCancelParams{Session: created.Session}, nil); err != nil {
		t.Fatal(err)
	}
	if err := client.Call(ctx, "session.list", protocol.SessionListParams{Archived: true}, &hidden); err != nil || len(hidden) != 0 {
		t.Fatalf("a deleted session is listed: %+v %v", hidden, err)
	}
}
