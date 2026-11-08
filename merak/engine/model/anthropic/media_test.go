package anthropic_test

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/TongTong313/merakcode/merak/engine/model"
	"github.com/TongTong313/merakcode/merak/engine/model/anthropic"
)

func TestImagesAndPDFRemainNativeBlocksIncludingToolResults(t *testing.T) {
	requests := make(chan map[string]any, 1)
	host := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var request map[string]any
		if err := json.NewDecoder(r.Body).Decode(&request); err != nil {
			t.Error(err)
		}
		requests <- request
		w.Header().Set("Content-Type", "text/event-stream")
		io.WriteString(w, "event: message_stop\ndata: {\"type\":\"message_stop\"}\n\n")
	}))
	defer host.Close()
	parts := []model.Part{
		{Text: "Inspect these"},
		{Image: &model.Image{MIME: "image/png", Data: []byte{1, 2, 3}}},
		{Image: &model.Image{MIME: "image/jpeg", URL: "https://example.com/image.jpg"}},
		{Document: &model.Document{MIME: "application/pdf", Name: "report.pdf", Data: []byte("%PDF")}},
	}
	stream, err := anthropic.New(anthropic.Options{BaseURL: host.URL}).Stream(context.Background(), model.Request{Messages: []model.Message{{Role: model.User, Parts: parts}, {Role: model.Tool, Parts: []model.Part{{ToolResult: &model.ToolResult{CallID: "read-image", Parts: parts[1:2]}}}}}})
	if err != nil {
		t.Fatal(err)
	}
	collect(t, stream)
	messages := (<-requests)["messages"].([]any)
	blocks := messages[0].(map[string]any)["content"].([]any)
	if len(blocks) != 4 {
		t.Fatalf("media blocks=%+v", blocks)
	}
	image := blocks[1].(map[string]any)["source"].(map[string]any)
	if image["type"] != "base64" || image["media_type"] != "image/png" || image["data"] != "AQID" {
		t.Fatalf("image=%+v", image)
	}
	url := blocks[2].(map[string]any)["source"].(map[string]any)
	if url["type"] != "url" || url["url"] != "https://example.com/image.jpg" {
		t.Fatalf("image URL=%+v", url)
	}
	doc := blocks[3].(map[string]any)
	if doc["type"] != "document" || doc["title"] != "report.pdf" || doc["source"].(map[string]any)["data"] != "JVBERg==" {
		t.Fatalf("document=%+v", doc)
	}
	result := messages[1].(map[string]any)["content"].([]any)[0].(map[string]any)
	content := result["content"].([]any)
	if len(content) != 1 || content[0].(map[string]any)["type"] != "image" {
		t.Fatalf("tool image=%+v", result)
	}
}
