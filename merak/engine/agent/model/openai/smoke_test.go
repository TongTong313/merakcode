package openai_test

import (
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/TongTong313/merakcode/merak/engine/agent/model"
	"github.com/TongTong313/merakcode/merak/engine/agent/model/openai"
)

func TestSmokeConfiguredProvider(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "" || r.Header.Get("X-Api-Key") != "" {
			t.Error("local model request carried credentials")
		}
		w.Header().Set("Content-Type", "text/event-stream")
		io.WriteString(w, "data: {\"choices\":[{\"delta\":{\"content\":\"OK\"},\"finish_reason\":\"stop\"}]}\n\ndata: [DONE]\n\n")
	}))
	defer server.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 45*time.Second)
	defer cancel()
	provider := openai.New(openai.Options{BaseURL: server.URL, Model: "fixture-model"})
	stream, err := provider.Stream(ctx, model.Request{Messages: []model.Message{{Role: model.User, Parts: []model.Part{{Text: "Reply with the word OK."}}}}})
	if err != nil {
		t.Fatal(err)
	}
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
	message, _, stop := collector.Message()
	if len(message.Parts) == 0 || message.Parts[0].Text != "OK" || stop != model.EndTurn {
		t.Fatal("provider did not complete a text response")
	}
}
