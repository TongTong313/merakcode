package openai_test

import (
	"context"
	"io"
	"os"
	"testing"
	"time"

	"github.com/TongTong313/merakcode/merak/engine/model"
	"github.com/TongTong313/merakcode/merak/engine/model/openai"
)

func TestSmokeConfiguredProvider(t *testing.T) {
	key, name := os.Getenv("OPENAI_API_KEY"), os.Getenv("OPENAI_MODEL")
	if key == "" || name == "" {
		t.Skip("OPENAI_API_KEY and OPENAI_MODEL are required for the live smoke test")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 45*time.Second)
	defer cancel()
	provider := openai.New(openai.Options{BaseURL: os.Getenv("OPENAI_BASE_URL"), APIKey: key, Model: name})
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
	if len(message.Parts) == 0 || stop != model.EndTurn {
		t.Fatal("provider did not complete a text response")
	}
}
