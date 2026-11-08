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
	"reflect"
	"testing"

	"github.com/TongTong313/merakcode/merak/engine/model"
	"github.com/TongTong313/merakcode/merak/engine/model/anthropic"
)

func TestAssistantPartsRoundTripThroughTheProviderWireFormat(t *testing.T) {
	data, err := os.ReadFile("testdata/assistant.json")
	if err != nil {
		t.Fatal(err)
	}
	var compact bytes.Buffer
	if err := json.Compact(&compact, data); err != nil {
		t.Fatal(err)
	}
	var original model.Message
	if err := json.Unmarshal(compact.Bytes(), &original); err != nil {
		t.Fatal(err)
	}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body struct {
			Messages []struct {
				Content []json.RawMessage `json:"content"`
			} `json:"messages"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			t.Error(err)
			return
		}
		if len(body.Messages) != 1 {
			t.Error("expected one assistant message")
			return
		}
		w.Header().Set("Content-Type", "text/event-stream")
		for index, content := range body.Messages[0].Content {
			start, _ := json.Marshal(map[string]any{"type": "content_block_start", "index": index, "content_block": content})
			_, _ = fmt.Fprintf(w, "event: content_block_start\ndata: %s\n\nevent: content_block_stop\ndata: {\"type\":\"content_block_stop\",\"index\":%d}\n\n", start, index)
		}
		_, _ = io.WriteString(w, "event: message_stop\ndata: {\"type\":\"message_stop\"}\n\n")
	}))
	defer server.Close()
	stream, err := anthropic.New(anthropic.Options{BaseURL: server.URL}).Stream(context.Background(), model.Request{Model: "test", Messages: []model.Message{original}})
	if err != nil {
		t.Fatal(err)
	}
	roundtrip, _, _ := collect(t, stream)
	if !reflect.DeepEqual(roundtrip, original) {
		got, _ := json.Marshal(roundtrip)
		t.Fatalf("round trip changed parts: %s", got)
	}
}
