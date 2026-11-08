package memory_test

import (
	"context"
	"fmt"
	"testing"

	"github.com/TongTong313/merakcode/merak/engine/memory"
	"github.com/TongTong313/merakcode/merak/engine/model"
	"github.com/TongTong313/merakcode/merak/engine/model/fake"
)

func TestExtractorProposesNotesFromConversationWithoutExecutingTools(t *testing.T) {
	provider := fake.New(t, fake.Reply{Text: `[{"kind":"pitfall","text":"Run checks from the Go module directory.","tags":["merak/"]}]`, Expect: func(req model.Request) error {
		if len(req.Tools) != 0 || len(req.Messages) != 1 || req.Messages[0].Parts[0].Text != "Checks passed after changing into merak/." {
			return fmt.Errorf("incorrect extraction input")
		}
		return nil
	}})
	extractor := memory.ModelExtractor{Provider: provider, Model: "test"}
	notes, err := extractor.Extract(context.Background(), []model.Message{{Role: model.User, Parts: []model.Part{{Text: "Checks passed after changing into merak/."}}}})
	if err != nil || len(notes) != 1 || notes[0].Kind != "pitfall" || notes[0].Text != "Run checks from the Go module directory." || len(notes[0].Tags) != 1 || notes[0].Tags[0] != "merak/" {
		t.Fatalf("notes=%+v error=%v", notes, err)
	}
}
