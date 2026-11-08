package session_test

import (
	"encoding/json"
	"reflect"
	"testing"

	"github.com/TongTong313/merakcode/merak/engine/event"
	"github.com/TongTong313/merakcode/merak/engine/model"
	"github.com/TongTong313/merakcode/merak/engine/session"
)

func TestFoldBuildsConversationFromMessageEvents(t *testing.T) {
	var state session.State
	for _, e := range []event.Event{
		{Seq: 1, Type: "message.sent", Payload: json.RawMessage(`{"role":"user","parts":[{"text":"Hello"}]}`)},
		{Seq: 2, Type: "message.completed", Payload: json.RawMessage(`{"role":"assistant","parts":[{"text":"Welcome"}]}`)},
	} {
		if err := session.Fold(&state, e); err != nil {
			t.Fatal(err)
		}
	}
	want := []model.Message{
		{Role: model.User, Parts: []model.Part{{Text: "Hello"}}},
		{Role: model.Assistant, Parts: []model.Part{{Text: "Welcome"}}},
	}
	if !reflect.DeepEqual(state.Messages, want) || state.LastSeq != 2 {
		t.Fatalf("state = %+v, want messages=%+v and lastSeq=2", state, want)
	}
}
