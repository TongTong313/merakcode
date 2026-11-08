package openai_test

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"slices"
	"testing"

	"github.com/TongTong313/merakcode/merak/engine/model"
	"github.com/TongTong313/merakcode/merak/engine/model/openai"
)

func TestImagesAndPDFEncodeAsContentPartsAndToolImagesFollowResults(t *testing.T) {
	requests := make(chan map[string]any, 1)
	host := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var request map[string]any
		if err := json.NewDecoder(r.Body).Decode(&request); err != nil {
			t.Error(err)
		}
		requests <- request
		w.Header().Set("Content-Type", "text/event-stream")
		io.WriteString(w, "data: [DONE]\n\n")
	}))
	defer host.Close()
	picture := &model.Image{MIME: "image/png", Data: []byte{1, 2, 3}}
	stream, err := openai.New(openai.Options{BaseURL: host.URL}).Stream(context.Background(), model.Request{Messages: []model.Message{
		{Role: model.User, Parts: []model.Part{{Text: "Inspect"}, {Image: picture}, {Image: &model.Image{MIME: "image/jpeg", URL: "https://example.com/image.jpg"}}, {Document: &model.Document{MIME: "application/pdf", Name: "report.pdf", Data: []byte("%PDF")}}}},
		{Role: model.Tool, Parts: []model.Part{{ToolResult: &model.ToolResult{CallID: "picture", Parts: []model.Part{{Text: "Screenshot"}, {Image: picture}}}}}},
	}})
	if err != nil {
		t.Fatal(err)
	}
	defer stream.Close()
	messages := (<-requests)["messages"].([]any)
	content, ok := messages[0].(map[string]any)["content"].([]any)
	if !ok || len(content) != 4 {
		t.Fatalf("content=%+v", messages[0])
	}
	if content[1].(map[string]any)["image_url"].(map[string]any)["url"] != "data:image/png;base64,AQID" || content[2].(map[string]any)["image_url"].(map[string]any)["url"] != "https://example.com/image.jpg" {
		t.Fatalf("images=%+v", content)
	}
	file := content[3].(map[string]any)["file"].(map[string]any)
	if file["filename"] != "report.pdf" || file["file_data"] != "data:application/pdf;base64,JVBERg==" {
		t.Fatalf("file=%+v", file)
	}
	if len(messages) != 3 || messages[1].(map[string]any)["role"] != "tool" || messages[1].(map[string]any)["content"] != "Screenshot" || messages[2].(map[string]any)["role"] != "user" {
		t.Fatalf("tool media=%+v", messages)
	}
	images := messages[2].(map[string]any)["content"].([]any)
	if images[len(images)-1].(map[string]any)["type"] != "image_url" {
		t.Fatalf("tool image=%+v", images)
	}
}

func TestTextDocumentBecomesTextAndReportsLostDocumentFormatting(t *testing.T) {
	requests := make(chan map[string]any, 1)
	host := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body map[string]any
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			t.Error(err)
		}
		requests <- body
		io.WriteString(w, "data: [DONE]\n\n")
	}))
	defer host.Close()
	stream, err := openai.New(openai.Options{BaseURL: host.URL}).Stream(context.Background(), model.Request{Messages: []model.Message{{Role: model.User, Parts: []model.Part{{Document: &model.Document{MIME: "text/plain", Name: "note.txt", Data: []byte("Document text")}}}}}})
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
	if messages[0].(map[string]any)["content"] != "Document text" || !slices.Contains(collector.Dropped(), "document") {
		t.Fatalf("request=%+v dropped=%v", messages, collector.Dropped())
	}
}
