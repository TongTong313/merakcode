package loop_test

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/TongTong313/merakcode/merak/engine/event"
	"github.com/TongTong313/merakcode/merak/engine/loop"
	"github.com/TongTong313/merakcode/merak/engine/model"
	"github.com/TongTong313/merakcode/merak/engine/model/fake"
	"github.com/TongTong313/merakcode/merak/engine/session"
	"github.com/TongTong313/merakcode/merak/engine/store"
	"github.com/TongTong313/merakcode/merak/engine/store/memory"
	"github.com/TongTong313/merakcode/merak/engine/tool"
)

func TestLargeToolOutputIsStoredBeforeItEntersHistory(t *testing.T) {
	dir := t.TempDir()
	body := "FIRST\n" + strings.Repeat("middle line\n", 10000) + "LAST"
	if err := os.WriteFile(filepath.Join(dir, "large.txt"), []byte(body), 0o600); err != nil {
		t.Fatal(err)
	}
	docs := memory.New()
	bus := event.NewBus(nil, time.Now, event.NewID)
	events, unsubscribe := bus.Subscribe(event.Filter{})
	defer unsubscribe()
	runner := loop.Loop{Model: fake.New(t,
		fake.Reply{Calls: []model.ToolCall{{ID: "large", Name: "read_file", Input: []byte(`{"path":"large.txt"}`)}}},
		fake.Reply{Text: "Read the preview.", Expect: func(req model.Request) error {
			result := req.Messages[2].Parts[0].ToolResult
			text := result.Parts[0].Text
			if len(text) > 32768 || !strings.Contains(text, "FIRST") || !strings.Contains(text, "LAST") || !strings.Contains(text, "mrk://blob/large") || !strings.Contains(text, "10002 lines") {
				return fmt.Errorf("unbounded or incomplete preview: %d bytes", len(text))
			}
			return nil
		}},
	), Bus: bus, Tools: tool.NewPool("test", tool.ReadFile{}), Env: tool.Env{Workdir: dir, Spill: func(ctx context.Context, name string, body []byte) (tool.Ref, error) {
		err := docs.Put(ctx, store.Doc{Kind: "blob", Key: "large", Body: body, Meta: map[string]string{"title": name}})
		return tool.Ref("mrk://blob/large"), err
	}}}
	state := session.State{ID: "spill-chat"}
	if _, err := runner.RunTurn(context.Background(), &state, loop.Input{Parts: []model.Part{{Text: "Read output"}}}); err != nil {
		t.Fatal(err)
	}
	unsubscribe()
	found := false
	for e := range events {
		if e.Type == tool.Completed {
			result, err := event.Decode[tool.Completion](e)
			if err != nil || !result.Truncated || result.Full != "mrk://blob/large" {
				t.Fatalf("completion=%+v error=%v", result, err)
			}
			found = true
		}
	}
	doc, err := docs.Fetch(context.Background(), "blob", "large")
	if !found || err != nil || string(doc.Body) != body {
		t.Fatalf("complete output was not stored: found=%v error=%v", found, err)
	}
}
