package openai_test

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"reflect"
	"testing"
	"time"

	"github.com/TongTong313/merakcode/merak/engine/model"
	"github.com/TongTong313/merakcode/merak/engine/model/openai"
)

func TestCancellingTheRequestStopsReadingTheStream(t *testing.T) {
	closed := make(chan struct{})
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		w.(http.Flusher).Flush()
		<-r.Context().Done()
		close(closed)
	}))
	defer server.Close()
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	stream, err := openai.New(openai.Options{BaseURL: server.URL}).Stream(ctx, model.Request{Model: "test-model"})
	if err != nil {
		t.Fatal(err)
	}
	defer stream.Close()
	cancel()
	if _, err := stream.Recv(); !errors.Is(err, context.Canceled) {
		t.Fatalf("Recv error = %v, want cancellation", err)
	}
	select {
	case <-closed:
	case <-time.After(3 * time.Second):
		t.Fatal("HTTP request remained open after cancellation")
	}
}

func TestProviderFailuresCarryAStableErrorCode(t *testing.T) {
	for _, test := range []struct {
		name   string
		status int
		body   string
	}{
		{"reports HTTP failure", http.StatusUnauthorized, `{"error":{"message":"private service detail"}}`},
		{"reports malformed stream data", http.StatusOK, "data: not-json\n\n"},
		{"reports an error event", http.StatusOK, "data: {\"error\":{\"message\":\"private service detail\",\"type\":\"server_error\"}}\n\ndata: [DONE]\n\n"},
		{"reports a truncated stream", http.StatusOK, "data: {\"choices\":[{\"index\":0,\"delta\":{\"content\":\"partial\"}}]}\n\n"},
	} {
		t.Run(test.name, func(t *testing.T) {
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				w.Header().Set("Content-Type", "text/event-stream")
				w.WriteHeader(test.status)
				_, _ = io.WriteString(w, test.body)
			}))
			defer server.Close()
			stream, err := openai.New(openai.Options{BaseURL: server.URL}).Stream(context.Background(), model.Request{Model: "test-model"})
			if err == nil {
				defer stream.Close()
				for err == nil {
					_, err = stream.Recv()
				}
			}
			var failure *model.Error
			if !errors.As(err, &failure) || failure.Code != "MRK-2001" {
				t.Fatalf("provider failure has no registered error code: %v", err)
			}
		})
	}
}

func TestStreamEncodesMessagesToolsAndToolResults(t *testing.T) {
	received := make(chan map[string]any, 1)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body map[string]any
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			t.Error(err)
		}
		received <- body
		w.Header().Set("Content-Type", "text/event-stream")
		_, _ = io.WriteString(w, "data: [DONE]\n\n")
	}))
	defer server.Close()
	provider := openai.New(openai.Options{BaseURL: server.URL})
	stream, err := provider.Stream(context.Background(), model.Request{
		Model: "test-model", System: "Follow project rules.",
		Tools: []model.ToolSpec{{Name: "read_file", Description: "Read a file.", Input: []byte(`{"type":"object","properties":{"path":{"type":"string"}},"required":["path"]}`)}},
		Messages: []model.Message{
			{Role: model.User, Parts: []model.Part{{Text: "Read both files."}}},
			{Role: model.Assistant, Parts: []model.Part{
				{Text: "Reading."},
				{ToolCall: &model.ToolCall{ID: "call-a", Name: "read_file", Input: []byte(`{"path":"a.txt"}`)}},
				{ToolCall: &model.ToolCall{ID: "call-b", Name: "read_file", Input: []byte(`{"path":"b.txt"}`)}},
			}},
			{Role: model.Tool, Parts: []model.Part{
				{ToolResult: &model.ToolResult{CallID: "call-a", Parts: []model.Part{{Text: "Alpha"}}}},
				{ToolResult: &model.ToolResult{CallID: "call-b", Parts: []model.Part{{Text: "Permission denied."}}, IsError: true}},
			}},
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	stream.Close()
	var want map[string]any
	if err := json.Unmarshal([]byte(`{
		"model":"test-model","stream":true,"stream_options":{"include_usage":true},
		"messages":[
			{"role":"system","content":"Follow project rules."},
			{"role":"user","content":"Read both files."},
			{"role":"assistant","content":"Reading.","tool_calls":[
				{"id":"call-a","type":"function","function":{"name":"read_file","arguments":"{\"path\":\"a.txt\"}"}},
				{"id":"call-b","type":"function","function":{"name":"read_file","arguments":"{\"path\":\"b.txt\"}"}}
			]},
			{"role":"tool","tool_call_id":"call-a","content":"Alpha"},
			{"role":"tool","tool_call_id":"call-b","content":"Error: Permission denied."}
		],
		"tools":[{"type":"function","function":{"name":"read_file","description":"Read a file.","parameters":{"type":"object","properties":{"path":{"type":"string"}},"required":["path"]}}}]
	}`), &want); err != nil {
		t.Fatal(err)
	}
	if got := <-received; !reflect.DeepEqual(got, want) {
		t.Fatalf("request = %+v, want %+v", got, want)
	}
}

func TestStreamCollectsTextInterleavedCallsAndUsage(t *testing.T) {
	fixture, err := os.ReadFile("testdata/tool-stream.sse")
	if err != nil {
		t.Fatal(err)
	}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != "POST" || r.URL.Path != "/v1/chat/completions" || r.Header.Get("Authorization") != "Bearer test-key" {
			t.Error("invalid request method, path, or authentication")
		}
		w.Header().Set("Content-Type", "text/event-stream")
		_, _ = w.Write(fixture)
	}))
	defer server.Close()
	provider := openai.New(openai.Options{BaseURL: server.URL + "/v1", APIKey: "test-key"})
	stream, err := provider.Stream(context.Background(), model.Request{Model: "test-model"})
	if err != nil {
		t.Fatal(err)
	}
	defer stream.Close()
	var collector model.Collector
	var text []string
	for {
		chunk, err := stream.Recv()
		if err == io.EOF {
			break
		}
		if err != nil {
			t.Fatal(err)
		}
		if chunk.Kind == model.Text {
			text = append(text, chunk.Text)
		}
		collector.Add(chunk)
	}
	message, usage, stop := collector.Message()
	if !reflect.DeepEqual(text, []string{"Reading ", "files."}) || stop != model.ToolUse || usage.Input != 12 || usage.Output != 5 || usage.CacheRead != 2 {
		t.Fatalf("text=%v stop=%s usage=%+v", text, stop, usage)
	}
	if len(message.Parts) != 3 || message.Parts[0].Text != "Reading files." {
		t.Fatalf("parts = %+v", message.Parts)
	}
	for index, want := range []struct{ id, input string }{{"call-a", `{"path":"a.txt"}`}, {"call-b", `{"path":"b.txt"}`}} {
		call := message.Parts[index+1].ToolCall
		if call == nil || call.ID != want.id || call.Name != "read_file" || string(call.Input) != want.input {
			t.Fatalf("call %d = %+v, want %+v", index, call, want)
		}
	}
}
