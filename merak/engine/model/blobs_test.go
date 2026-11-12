package model_test

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"testing"

	"github.com/TongTong313/merakcode/merak/engine/model"
	"github.com/TongTong313/merakcode/merak/engine/model/fake"
)

func TestAnImageHeldAsABlobReferenceReachesTheProviderAsItsBytes(t *testing.T) {
	picture := []byte{0x89, 'P', 'N', 'G', 1, 2, 3}
	var seen model.Request
	inner := fake.New(t, fake.Reply{Text: "ok", Expect: func(req model.Request) error { seen = req; return nil }})
	provider := model.Blobs{Provider: inner, Read: func(_ context.Context, key string) ([]byte, error) {
		if key != "abc" {
			return nil, errors.New("unknown blob " + key)
		}
		return picture, nil
	}}
	request := model.Request{Messages: []model.Message{
		{Role: model.User, Parts: []model.Part{{Text: "look"}, {Image: &model.Image{MIME: "image/png", URL: "mrk://blob/abc"}}, {Image: &model.Image{MIME: "image/png", URL: "https://example.test/a.png"}}}},
		{Role: model.Tool, Parts: []model.Part{{ToolResult: &model.ToolResult{CallID: "c", Parts: []model.Part{{Image: &model.Image{MIME: "image/png", URL: "mrk://blob/abc"}}}}}}},
	}}
	stream, err := provider.Stream(t.Context(), request)
	if err != nil {
		t.Fatal(err)
	}
	stream.Close()
	user := seen.Messages[0].Parts
	if !bytes.Equal(user[1].Image.Data, picture) || user[1].Image.URL != "" || user[2].Image.URL != "https://example.test/a.png" {
		t.Fatalf("user parts = %+v %+v", user[1].Image, user[2].Image)
	}
	if got := seen.Messages[1].Parts[0].ToolResult.Parts[0].Image; !bytes.Equal(got.Data, picture) || got.URL != "" {
		t.Fatalf("tool result image = %+v", got)
	}
	if request.Messages[0].Parts[1].Image.URL != "mrk://blob/abc" || request.Messages[0].Parts[1].Image.Data != nil {
		t.Fatal("the stored history was changed instead of a copy")
	}
	if provider.Name() != "fake" {
		t.Fatalf("name = %s", provider.Name())
	}
}

func TestAnImageWhoseBlobIsGoneFailsTheRequestInsteadOfSendingAnUnreadableReference(t *testing.T) {
	inner := fake.New(nil, fake.Reply{Text: "never"})
	provider := model.Blobs{Provider: inner, Read: func(context.Context, string) ([]byte, error) { return nil, fmt.Errorf("gone") }}
	_, err := provider.Stream(t.Context(), model.Request{Messages: []model.Message{{Role: model.User, Parts: []model.Part{{Image: &model.Image{MIME: "image/png", URL: "mrk://blob/x"}}}}}})
	if err == nil {
		t.Fatal("the request went out with a reference no provider can read")
	}
}
