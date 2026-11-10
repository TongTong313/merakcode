package server_test

import (
	"encoding/json"
	"testing"

	"github.com/TongTong313/merakcode/merak/engine"
	"github.com/TongTong313/merakcode/merak/engine/event"
	"github.com/TongTong313/merakcode/merak/engine/group"
	"github.com/TongTong313/merakcode/merak/engine/task"
	"github.com/TongTong313/merakcode/merak/internal/server"
	"github.com/TongTong313/merakcode/merak/protocol"
)

func TestSDKInboxIgnoresLateNoticesForCompletedReviews(t *testing.T) {
	ctx := t.Context()
	e, err := engine.New(engine.Deps{})
	if err != nil {
		t.Fatal(err)
	}
	host, err := server.Start(e, t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer host.Close()
	client, err := protocol.Connect(ctx, host.Info.Endpoint, host.Info.Token, protocol.HelloParams{Protocol: protocol.Version})
	if err != nil {
		t.Fatal(err)
	}
	defer client.Close()
	emit := func(kind event.Type, value any, cause event.ID) event.ID {
		body, _ := json.Marshal(value)
		fact, err := e.Bus.Publish(ctx, event.Event{Stream: "group:inbox", Scope: event.Scope{Group: "inbox", Task: "task"}, Type: kind, Payload: body, Cause: cause})
		if err != nil {
			t.Fatal(err)
		}
		return fact.ID
	}
	card := task.Card{ID: "task", Group: "inbox", Status: task.Review}
	old := emit(task.Reported, card, "")
	notice := group.Notice{Kind: "review", To: []event.ID{"owner"}}
	emit(group.NoticeSent, notice, old)
	emit(task.Reviewed, card, "")
	emit(group.NoticeSent, notice, old)
	inbox, err := client.GroupInbox(ctx, "inbox", "owner")
	if err != nil || len(inbox) != 0 {
		t.Fatalf("stale inbox=%+v %v", inbox, err)
	}
	current := emit(task.Reported, card, "")
	emit(group.NoticeSent, notice, current)
	emit(group.NoticeSent, notice, old)
	inbox, err = client.GroupInbox(ctx, "inbox", "owner")
	if err != nil || len(inbox) != 1 || inbox[0].Request != current {
		t.Fatalf("current inbox=%+v %v", inbox, err)
	}
}
