package openai_test

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/TongTong313/merakcode/merak/engine/model"
	"github.com/TongTong313/merakcode/merak/engine/model/openai"
)

func TestGeminiToolSignatureReturnsOnlyToGemini(t *testing.T) {
	requests := make(chan string, 3)
	host := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		requests <- string(body)
		w.Header().Set("Content-Type", "text/event-stream")
		io.WriteString(w, "data: {\"choices\":[{\"index\":0,\"delta\":{\"tool_calls\":[{\"index\":0,\"id\":\"call-one\",\"function\":{\"name\":\"read_file\",\"arguments\":\"{}\"},\"extra_content\":{\"google\":{\"thought_signature\":\"opaque-signature\"}}}]},\"finish_reason\":\"tool_calls\"}]}\n\ndata: [DONE]\n\n")
	}))
	defer host.Close()
	config, _ := openai.Builtin("gemini")
	provider := openai.New(openai.Options{Config: config, BaseURL: host.URL})
	request := model.Request{Model: "gemini-3.1-pro-preview"}
	stream, err := provider.Stream(context.Background(), request)
	if err != nil {
		t.Fatal(err)
	}
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
	stream.Close()
	<-requests
	message, _, _ := collector.Message()
	request.Messages = []model.Message{message, {Role: model.Tool, Parts: []model.Part{{ToolResult: &model.ToolResult{CallID: "call-one", Parts: []model.Part{{Text: "done"}}}}}}}
	stream, err = provider.Stream(context.Background(), request)
	if err != nil {
		t.Fatal(err)
	}
	stream.Close()
	var wire struct {
		Messages []struct {
			Calls []struct {
				Extra json.RawMessage `json:"extra_content"`
			} `json:"tool_calls"`
		} `json:"messages"`
	}
	if err := json.Unmarshal([]byte(<-requests), &wire); err != nil {
		t.Fatal(err)
	}
	if len(wire.Messages[0].Calls) != 1 || string(wire.Messages[0].Calls[0].Extra) != `{"google":{"thought_signature":"opaque-signature"}}` {
		t.Fatalf("signature lost: %+v", wire)
	}
	other := openai.New(openai.Options{BaseURL: host.URL})
	stream, err = other.Stream(context.Background(), request)
	if err != nil {
		t.Fatal(err)
	}
	stream.Close()
	if strings.Contains(<-requests, "opaque-signature") {
		t.Fatal("signature crossed provider boundary")
	}
}
