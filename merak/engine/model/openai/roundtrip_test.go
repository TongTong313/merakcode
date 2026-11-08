package openai_test

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"reflect"
	"testing"
	"time"

	"github.com/TongTong313/merakcode/merak/engine/event"
	"github.com/TongTong313/merakcode/merak/engine/loop"
	"github.com/TongTong313/merakcode/merak/engine/model"
	"github.com/TongTong313/merakcode/merak/engine/model/openai"
	"github.com/TongTong313/merakcode/merak/engine/session"
	"github.com/TongTong313/merakcode/merak/engine/tool"
)

func TestConversationRoundTripPreservesReasoningCallsAndGroupedResults(t *testing.T) {
	data, err := os.ReadFile("../testdata/conversation.json")
	if err != nil {
		t.Fatal(err)
	}
	var compact bytes.Buffer
	if err := json.Compact(&compact, data); err != nil {
		t.Fatal(err)
	}
	var want []model.Message
	if err := json.Unmarshal(compact.Bytes(), &want); err != nil {
		t.Fatal(err)
	}
	fixture, err := os.ReadFile("testdata/conversation-tools.sse")
	if err != nil {
		t.Fatal(err)
	}
	requests := make(chan map[string]any, 2)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body map[string]any
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			t.Error(err)
			return
		}
		requests <- body
		w.Header().Set("Content-Type", "text/event-stream")
		if len(body["messages"].([]any)) == 1 {
			_, _ = w.Write(fixture)
			return
		}
		_, _ = io.WriteString(w, "data: {\"choices\":[{\"index\":0,\"delta\":{\"content\":\"Done.\"},\"finish_reason\":\"stop\"}]}\n\ndata: [DONE]\n\n")
	}))
	defer server.Close()
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "notes.txt"), []byte("Shared fixture content."), 0o600); err != nil {
		t.Fatal(err)
	}
	provider := openai.New(openai.Options{BaseURL: server.URL, Config: openai.Config{Name: "fixture", ReasoningField: "reasoning_content", SendReasoning: true}})
	runner := loop.Loop{Model: provider, Bus: event.NewBus(nil, time.Now, event.NewID), Tools: tool.NewPool("test", tool.ReadFile{}), Env: tool.Env{Workdir: dir}}
	state := session.State{ID: "roundtrip"}
	if _, err := runner.RunTurn(context.Background(), &state, loop.Input{Parts: want[0].Parts}); err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(state.Messages, want) {
		got, _ := json.Marshal(state.Messages)
		t.Fatalf("conversation changed: %s", got)
	}
	<-requests
	body := <-requests
	messages := body["messages"].([]any)
	if len(messages) != 4 || messages[1].(map[string]any)["reasoning_content"] != "Check the requested file." {
		t.Fatalf("reasoning did not return with tool history: %+v", messages)
	}
	first, second := messages[2].(map[string]any), messages[3].(map[string]any)
	if first["role"] != "tool" || first["tool_call_id"] != "read-one" || first["content"] != "Shared fixture content." || second["role"] != "tool" || second["tool_call_id"] != "read-two" || second["content"] != "Error: path is required" {
		t.Fatalf("tool results changed: %+v", messages)
	}
}
