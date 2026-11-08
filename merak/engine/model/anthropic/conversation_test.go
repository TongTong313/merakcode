package anthropic_test

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
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
	"github.com/TongTong313/merakcode/merak/engine/model/anthropic"
	"github.com/TongTong313/merakcode/merak/engine/session"
	"github.com/TongTong313/merakcode/merak/engine/tool"
)

func TestSharedConversationRoundTripPreservesGroupedToolResults(t *testing.T) {
	body, err := os.ReadFile("../testdata/conversation.json")
	if err != nil {
		t.Fatal(err)
	}
	var compact bytes.Buffer
	if err := json.Compact(&compact, body); err != nil {
		t.Fatal(err)
	}
	var want []model.Message
	if err := json.Unmarshal(compact.Bytes(), &want); err != nil {
		t.Fatal(err)
	}
	want[1].Parts[0].Reasoning.Provider = "anthropic"
	want[1].Parts[0].Reasoning.Opaque = json.RawMessage(`"fixture-signature"`)
	requests := make(chan map[string]any, 2)
	host := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var request map[string]any
		if err := json.NewDecoder(r.Body).Decode(&request); err != nil {
			t.Error(err)
			return
		}
		requests <- request
		w.Header().Set("Content-Type", "text/event-stream")
		blocks := []string{`{"type":"text","text":"Done."}`}
		if len(request["messages"].([]any)) == 1 {
			blocks = []string{
				`{"type":"thinking","thinking":"Check the requested file.","signature":"fixture-signature"}`,
				`{"type":"text","text":"Reading."}`,
				`{"type":"tool_use","id":"read-one","name":"read_file","input":{"path":"notes.txt"}}`,
				`{"type":"tool_use","id":"read-two","name":"read_file","input":{}}`,
			}
		}
		for i, block := range blocks {
			fmt.Fprintf(w, "event: content_block_start\ndata: {\"type\":\"content_block_start\",\"index\":%d,\"content_block\":%s}\n\nevent: content_block_stop\ndata: {\"type\":\"content_block_stop\",\"index\":%d}\n\n", i, block, i)
		}
		io.WriteString(w, "event: message_stop\ndata: {\"type\":\"message_stop\"}\n\n")
	}))
	defer host.Close()
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "notes.txt"), []byte("Shared fixture content."), 0600); err != nil {
		t.Fatal(err)
	}
	runner := loop.Loop{Model: anthropic.New(anthropic.Options{BaseURL: host.URL}), Bus: event.NewBus(nil, time.Now, event.NewID), Tools: tool.NewPool("test", tool.ReadFile{}), Env: tool.Env{Workdir: dir}}
	state := session.State{ID: "shared"}
	if _, err := runner.RunTurn(context.Background(), &state, loop.Input{Parts: want[0].Parts}); err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(state.Messages, want) {
		encoded, _ := json.Marshal(state.Messages)
		t.Fatalf("conversation changed: %s", encoded)
	}
	<-requests
	request := <-requests
	messages := request["messages"].([]any)
	if len(messages) != 3 {
		t.Fatalf("grouped tool results missing: %+v", messages)
	}
	results := messages[2].(map[string]any)
	if results["role"] != "user" {
		t.Fatalf("result role=%v", results["role"])
	}
	content := results["content"].([]any)
	if len(content) != 2 || content[0].(map[string]any)["tool_use_id"] != "read-one" || content[1].(map[string]any)["is_error"] != true {
		t.Fatalf("tool results=%+v", content)
	}
}
