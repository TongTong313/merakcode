package openai_test

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"slices"
	"strings"
	"testing"

	"github.com/TongTong313/merakcode/merak/engine/model"
	"github.com/TongTong313/merakcode/merak/engine/model/openai"
	"github.com/TongTong313/merakcode/merak/internal/testpdf"
)

func TestUnsupportedPDFBecomesExtractedTextWithDroppedNotice(t *testing.T) {
	requests := make(chan map[string]any, 1)
	host := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body map[string]any
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			t.Error(err)
		}
		requests <- body
		w.Header().Set("Content-Type", "text/event-stream")
		io.WriteString(w, "data: [DONE]\n\n")
	}))
	defer host.Close()
	config, _ := openai.Builtin("deepseek")
	provider := openai.New(openai.Options{Config: config, BaseURL: host.URL})
	stream, err := provider.Stream(context.Background(), model.Request{Model: "deepseek-flash", Messages: []model.Message{{Role: model.User, Parts: []model.Part{{Document: &model.Document{MIME: "application/pdf", Name: "unicode.pdf", Data: testpdf.Unicode()}}}}}})
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
	messages := (<-requests)["messages"].([]any)
	content, ok := messages[0].(map[string]any)["content"].(string)
	if !ok || !strings.Contains(content, "\u4e16\u754c") {
		t.Fatalf("PDF text missing: %+v", messages)
	}
	if !slices.Contains(collector.Dropped(), "document") {
		t.Fatalf("missing conversion notice: %v", collector.Dropped())
	}
}

func TestUnreadablePDFIsDroppedWithoutFailingTheRequest(t *testing.T) {
	for _, test := range []struct {
		name string
		data []byte
	}{
		{"corrupt", []byte("%PDF-1.4 damaged")},
		{"no text", testpdf.Build("q 100 0 0 100 0 0 cm /Scan Do Q", 1)},
	} {
		t.Run(test.name, func(t *testing.T) {
			requests := make(chan map[string]any, 1)
			host := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				var body map[string]any
				if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
					t.Error(err)
				}
				requests <- body
				io.WriteString(w, "data: {\"choices\":[{\"index\":0,\"delta\":{\"content\":\"Continue\"},\"finish_reason\":\"stop\"}]}\n\ndata: [DONE]\n\n")
			}))
			defer host.Close()
			config, _ := openai.Builtin("deepseek")
			stream, err := openai.New(openai.Options{BaseURL: host.URL, Config: config}).Stream(context.Background(), model.Request{Messages: []model.Message{{Role: model.User, Parts: []model.Part{{Text: "Continue"}, {Document: &model.Document{MIME: "application/pdf", Data: test.data, Name: "input.pdf"}}}}}})
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
			request := <-requests
			message, _, _ := collector.Message()
			if request["messages"].([]any)[0].(map[string]any)["content"] != "Continue" || !slices.Contains(collector.Dropped(), "document") || len(message.Parts) != 1 || message.Parts[0].Text != "Continue" {
				t.Fatalf("request=%+v message=%+v dropped=%v", request, message, collector.Dropped())
			}
		})
	}
}
