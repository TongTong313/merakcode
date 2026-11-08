package session_test

import (
	"encoding/json"
	"testing"

	"github.com/TongTong313/merakcode/merak/engine/event"
	"github.com/TongTong313/merakcode/merak/engine/model"
	"github.com/TongTong313/merakcode/merak/engine/session"
)

func TestChildReportIsInsertedOnceWhenCompletionIsReplayed(t *testing.T) {
	state := &session.State{ID: "parent"}
	for _, item := range []struct {
		kind    event.Type
		payload session.ChildResult
	}{
		{session.ChildStarted, session.ChildResult{ID: "child"}},
		{session.ChildFinished, session.ChildResult{ID: "child", Stop: "answered", Report: []model.Part{{Text: "Research result"}}}},
		{session.ChildFinished, session.ChildResult{ID: "child", Stop: "answered", Report: []model.Part{{Text: "Research result"}}}},
	} {
		body, _ := json.Marshal(item.payload)
		if err := session.Fold(state, event.Event{Type: item.kind, Seq: state.LastSeq + 1, Payload: body}); err != nil {
			t.Fatal(err)
		}
	}
	if len(state.Messages) != 1 || state.Messages[0].Role != model.User || len(state.Messages[0].Parts) != 2 || state.Messages[0].Parts[1].Text != "Research result" || !state.Children["child"].Delivered {
		t.Fatalf("state=%+v", state)
	}
}
