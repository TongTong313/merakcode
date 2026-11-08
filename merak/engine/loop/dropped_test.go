package loop_test

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"reflect"
	"testing"
	"time"

	"github.com/TongTong313/merakcode/merak/engine/event"
	"github.com/TongTong313/merakcode/merak/engine/loop"
	"github.com/TongTong313/merakcode/merak/engine/model"
	"github.com/TongTong313/merakcode/merak/engine/model/anthropic"
	"github.com/TongTong313/merakcode/merak/engine/model/openai"
	"github.com/TongTong313/merakcode/merak/engine/session"
)

func TestUnsupportedProviderContentIsNamedInCompletedEvent(t *testing.T) {
	for _, test := range []struct {
		name, wire string
		dropped    []string
	}{
		{"anthropic", "event: content_block_start\ndata: {\"type\":\"content_block_start\",\"index\":0,\"content_block\":{\"type\":\"web_search_tool_result\",\"content\":[]}}\n\nevent: content_block_stop\ndata: {\"type\":\"content_block_stop\",\"index\":0}\n\nevent: content_block_start\ndata: {\"type\":\"content_block_start\",\"index\":1,\"content_block\":{\"type\":\"text\",\"text\":\"Answer\",\"citations\":[{\"type\":\"char_location\"}]}}\n\nevent: content_block_stop\ndata: {\"type\":\"content_block_stop\",\"index\":1}\n\nevent: message_stop\ndata: {\"type\":\"message_stop\"}\n\n", []string{"web_search_tool_result", "citations"}},
		{"openai", "data: {\"choices\":[{\"delta\":{\"content\":\"Answer\",\"audio\":{\"data\":\"omitted\"},\"annotations\":[{}]},\"finish_reason\":\"stop\"}]}\n\ndata: [DONE]\n\n", []string{"annotations", "audio"}},
	} {
		t.Run(test.name, func(t *testing.T) {
			host := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				w.Header().Set("Content-Type", "text/event-stream")
				io.WriteString(w, test.wire)
			}))
			defer host.Close()
			var provider model.Provider = openai.New(openai.Options{BaseURL: host.URL})
			if test.name == "anthropic" {
				provider = anthropic.New(anthropic.Options{BaseURL: host.URL})
			}
			bus := event.NewBus(nil, time.Now, event.NewID)
			facts, stop := bus.Subscribe(event.Filter{Types: []event.Type{session.MessageCompleted}})
			defer stop()
			runner := loop.Loop{Model: provider, Bus: bus}
			state := session.State{ID: "unsupported"}
			if _, err := runner.RunTurn(context.Background(), &state, loop.Input{Parts: []model.Part{{Text: "Answer"}}}); err != nil {
				t.Fatal(err)
			}
			var completed struct {
				Dropped []string `json:"dropped"`
			}
			fact := <-facts
			if err := json.Unmarshal(fact.Payload, &completed); err != nil {
				t.Fatal(err)
			}
			if !reflect.DeepEqual(completed.Dropped, test.dropped) || len(state.Messages[1].Parts) != 1 || state.Messages[1].Parts[0].Text != "Answer" {
				t.Fatalf("completion=%s", fact.Payload)
			}
		})
	}
}
