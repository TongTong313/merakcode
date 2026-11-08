package anthropic_test

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"reflect"
	"strings"
	"testing"

	"github.com/TongTong313/merakcode/merak/engine/model"
	"github.com/TongTong313/merakcode/merak/engine/model/anthropic"
	"github.com/TongTong313/merakcode/merak/engine/model/openai"
)

func collect(t *testing.T, stream model.Stream) (model.Message, model.Usage, model.StopReason) {
	t.Helper()
	defer stream.Close()
	var collector model.Collector
	for {
		chunk, err := stream.Recv()
		if err == io.EOF {
			break
		}
		if err != nil {
			t.Fatal(err)
		}
		collector.Add(chunk)
	}
	return collector.Message()
}

func TestStreamDecodesThinkingToolsUsageAndStopReasons(t *testing.T) {
	fixture, err := os.ReadFile("testdata/thinking-tools.sse")
	if err != nil {
		t.Fatal(err)
	}
	for _, test := range []struct {
		wire string
		stop model.StopReason
	}{
		{"tool_use", model.ToolUse}, {"refusal", model.Refusal},
	} {
		t.Run(test.wire, func(t *testing.T) {
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.URL.Path != "/v1/messages" {
					t.Errorf("request path = %q", r.URL.Path)
				}
				if r.Header.Get("Authorization") != "Bearer fixture-key" {
					t.Error("missing configured API authentication")
				}
				w.Header().Set("Content-Type", "text/event-stream")
				_, _ = io.WriteString(w, strings.ReplaceAll(string(fixture), `"stop_reason":"tool_use"`, `"stop_reason":"`+test.wire+`"`))
			}))
			defer server.Close()
			stream, err := anthropic.New(anthropic.Options{BaseURL: server.URL, APIKey: "fixture-key"}).Stream(context.Background(), model.Request{Model: "claude-sonnet-4-6", Messages: []model.Message{{Role: model.User, Parts: []model.Part{{Text: "Read notes"}}}}})
			if err != nil {
				t.Fatal(err)
			}
			message, usage, stop := collect(t, stream)
			want := []model.Part{
				{Reasoning: &model.Reasoning{Text: "Check the file.", Opaque: []byte(`"signed-value"`), Provider: "anthropic"}},
				{Text: "Reading."},
				{ToolCall: &model.ToolCall{ID: "call-one", Name: "read_file", Input: []byte(`{"path":"notes.txt"}`)}},
			}
			if !reflect.DeepEqual(message.Parts, want) || usage.Input != 30 || usage.Output != 8 || usage.CacheRead != 6 || usage.CacheWrite != 4 || stop != test.stop {
				t.Fatalf("message=%+v usage=%+v stop=%s", message, usage, stop)
			}
		})
	}
}

func TestFinalUsageReplacesInitialInputAndCacheCounts(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		io.WriteString(w, "event: message_start\ndata: {\"type\":\"message_start\",\"message\":{\"usage\":{\"input_tokens\":20,\"cache_read_input_tokens\":6,\"cache_creation_input_tokens\":4}}}\n\nevent: message_delta\ndata: {\"type\":\"message_delta\",\"delta\":{\"stop_reason\":\"end_turn\"},\"usage\":{\"input_tokens\":10,\"cache_read_input_tokens\":40,\"cache_creation_input_tokens\":0,\"output_tokens\":8}}\n\nevent: message_stop\ndata: {\"type\":\"message_stop\"}\n\n")
	}))
	defer server.Close()
	stream, err := anthropic.New(anthropic.Options{BaseURL: server.URL}).Stream(context.Background(), model.Request{Model: "test"})
	if err != nil {
		t.Fatal(err)
	}
	_, usage, _ := collect(t, stream)
	if usage.Input != 50 || usage.CacheRead != 40 || usage.CacheWrite != 0 || usage.Output != 8 {
		t.Fatalf("final usage=%+v", usage)
	}
}

func TestThinkingSignaturesReturnOnlyToTheirProvider(t *testing.T) {
	fixture, err := os.ReadFile("testdata/thinking-tools.sse")
	if err != nil {
		t.Fatal(err)
	}
	received := make(chan map[string]any, 2)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body map[string]any
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			t.Error(err)
		}
		received <- body
		w.Header().Set("Content-Type", "text/event-stream")
		_, _ = w.Write(fixture)
	}))
	defer server.Close()
	provider := anthropic.New(anthropic.Options{BaseURL: server.URL})
	stream, err := provider.Stream(context.Background(), model.Request{Model: "claude-sonnet-4-6"})
	if err != nil {
		t.Fatal(err)
	}
	message, _, _ := collect(t, stream)
	<-received
	message.Parts = append(message.Parts, model.Part{Reasoning: &model.Reasoning{Text: "Foreign thought", Provider: "other", Opaque: []byte(`"foreign-secret"`)}})
	stream, err = provider.Stream(context.Background(), model.Request{Model: "claude-sonnet-4-6", Messages: []model.Message{message}})
	if err != nil {
		t.Fatal(err)
	}
	collect(t, stream)
	body := <-received
	data, _ := json.Marshal(body)
	if strings.Contains(string(data), "foreign-secret") || strings.Contains(string(data), "Foreign thought") {
		t.Fatal("foreign thinking was sent to Anthropic")
	}
	content := body["messages"].([]any)[0].(map[string]any)["content"].([]any)
	if len(content) != 3 || content[0].(map[string]any)["signature"] != "signed-value" || content[0].(map[string]any)["thinking"] != "Check the file." {
		t.Fatalf("thinking was not replayed: %s", data)
	}

	openAIRequests := make(chan string, 1)
	other := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		openAIRequests <- string(body)
		w.Header().Set("Content-Type", "text/event-stream")
		_, _ = io.WriteString(w, "data: [DONE]\n\n")
	}))
	defer other.Close()
	stream, err = openai.New(openai.Options{BaseURL: other.URL}).Stream(context.Background(), model.Request{Model: "test", Messages: []model.Message{message}})
	if err != nil {
		t.Fatal(err)
	}
	collect(t, stream)
	encoded := <-openAIRequests
	if strings.Contains(encoded, "signed-value") || strings.Contains(encoded, "Check the file.") || strings.Contains(encoded, "Foreign thought") {
		t.Fatal("thinking crossed provider boundaries")
	}
}

func TestRedactedThinkingSurvivesTheNextRequest(t *testing.T) {
	received := make(chan map[string]any, 2)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body map[string]any
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			t.Error(err)
		}
		received <- body
		w.Header().Set("Content-Type", "text/event-stream")
		_, _ = io.WriteString(w, "event: content_block_start\ndata: {\"type\":\"content_block_start\",\"index\":0,\"content_block\":{\"type\":\"redacted_thinking\",\"data\":\"encrypted-value\"}}\n\nevent: content_block_stop\ndata: {\"type\":\"content_block_stop\",\"index\":0}\n\nevent: message_stop\ndata: {\"type\":\"message_stop\"}\n\n")
	}))
	defer server.Close()
	provider := anthropic.New(anthropic.Options{BaseURL: server.URL})
	stream, err := provider.Stream(context.Background(), model.Request{Model: "test"})
	if err != nil {
		t.Fatal(err)
	}
	message, _, _ := collect(t, stream)
	<-received
	if len(message.Parts) != 1 || message.Parts[0].Reasoning == nil {
		t.Fatalf("redacted thinking was lost: %+v", message)
	}
	before := string(message.Parts[0].Reasoning.Opaque)
	stream, err = provider.Stream(context.Background(), model.Request{Model: "test", Messages: []model.Message{message}})
	if err != nil {
		t.Fatal(err)
	}
	roundtrip, _, _ := collect(t, stream)
	body := <-received
	content := body["messages"].([]any)[0].(map[string]any)["content"].([]any)[0].(map[string]any)
	if content["type"] != "redacted_thinking" || content["data"] != "encrypted-value" || string(roundtrip.Parts[0].Reasoning.Opaque) != before {
		t.Fatalf("opaque content changed: %+v", content)
	}
}
