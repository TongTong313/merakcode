package loop_test

import (
	"context"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/TongTong313/merakcode/merak/engine/event"
	"github.com/TongTong313/merakcode/merak/engine/loop"
	"github.com/TongTong313/merakcode/merak/engine/model"
	"github.com/TongTong313/merakcode/merak/engine/model/fake"
	"github.com/TongTong313/merakcode/merak/engine/model/openai"
	"github.com/TongTong313/merakcode/merak/engine/session"
	"github.com/TongTong313/merakcode/merak/engine/tool"
)

func TestCancelledStreamKeepsPartialMessageAndUsage(t *testing.T) {
	host := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		_, _ = io.WriteString(w, "data: {\"choices\":[{\"delta\":{\"content\":\"Partial reply\"}}],\"usage\":{\"prompt_tokens\":13,\"completion_tokens\":2}}\n\n")
		w.(http.Flusher).Flush()
		<-r.Context().Done()
	}))
	defer host.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	bus := event.NewBus(nil, time.Now, event.NewID)
	facts, unsubscribe := bus.Subscribe(event.Filter{Types: []event.Type{session.MessageDelta}})
	defer unsubscribe()
	go func() {
		for fact := range facts {
			chunk, _ := event.Decode[model.Chunk](fact)
			if chunk.Kind == model.UsageChunk {
				cancel()
				return
			}
		}
	}()
	runner := loop.Loop{Bus: bus, Model: openai.New(openai.Options{BaseURL: host.URL})}
	state := session.State{ID: "partial"}
	result, err := runner.RunTurn(ctx, &state, loop.Input{Parts: []model.Part{{Text: "Hello"}}})
	if !errors.Is(err, context.Canceled) || result.Stop != loop.Cancelled || result.Usage.Input != 13 || state.Usage.Output != 2 || len(state.Messages) != 2 || state.Messages[1].Parts[0].Text != "Partial reply" {
		t.Fatalf("result=%+v state=%+v err=%v", result, state, err)
	}
}

func TestCancellingToolsClosesBothRunningAndUnstartedCalls(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	bus := event.NewBus(nil, time.Now, event.NewID)
	facts, unsubscribe := bus.Subscribe(event.Filter{Types: []event.Type{tool.Called}})
	defer unsubscribe()
	go func() {
		select {
		case <-facts:
			cancel()
		case <-ctx.Done():
		}
	}()
	jobs := new(tool.Jobs)
	defer jobs.Close()
	runner := loop.Loop{Bus: bus, Tools: tool.NewPool("test", tool.Bash{}, tool.ReadFile{}), Env: tool.Env{Jobs: jobs, Workdir: t.TempDir()}, Model: fake.New(t, fake.Reply{Calls: []model.ToolCall{
		{ID: "running", Name: "bash", Input: []byte(`{"command":"sleep 30"}`)},
		{ID: "unstarted", Name: "read_file", Input: []byte(`{"path":"missing.txt"}`)},
	}})}
	state := session.State{ID: "cancel-tools"}
	_, err := runner.RunTurn(ctx, &state, loop.Input{Parts: []model.Part{{Text: "Inspect"}}})
	if !errors.Is(err, context.Canceled) || len(state.Open) != 0 || len(state.Messages) != 3 || len(state.Messages[2].Parts) != 2 {
		t.Fatalf("state=%+v err=%v", state, err)
	}
	for _, part := range state.Messages[2].Parts {
		if part.ToolResult == nil || !part.ToolResult.IsError {
			t.Fatalf("interrupted result=%+v", part)
		}
	}
}
