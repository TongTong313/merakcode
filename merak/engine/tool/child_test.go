package tool_test

import (
	"context"
	"encoding/json"
	"testing"
	"time"

	"github.com/TongTong313/merakcode/merak/engine/event"
	"github.com/TongTong313/merakcode/merak/engine/loop"
	"github.com/TongTong313/merakcode/merak/engine/model"
	"github.com/TongTong313/merakcode/merak/engine/model/fake"
	"github.com/TongTong313/merakcode/merak/engine/session"
	storage "github.com/TongTong313/merakcode/merak/engine/store/memory"
	"github.com/TongTong313/merakcode/merak/engine/tool"
	"github.com/TongTong313/merakcode/merak/engine/worker/builtin"
)

func TestSpawnAndWaitChildUseTheSameOwnedBackgroundRun(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	release := make(chan struct{})
	provider := fake.New(t, fake.Reply{Text: "Complete", Hold: release})
	bus := event.NewBus(storage.New(), time.Now, event.NewID)
	runner := builtin.New(ctx, bus, event.NewID, func(ctx context.Context, id event.ID, input string) (loop.Outcome, error) {
		conversation := loop.Loop{Bus: bus, Model: provider, Tools: tool.NewPool("readonly")}
		return conversation.RunTurn(ctx, &session.State{ID: id}, loop.Input{Parts: []model.Part{{Text: input}}})
	})
	defer runner.Close()
	env := tool.Env{Children: runner}
	spawn, err := (tool.Spawn{}).Run(ctx, tool.Call{Env: env, Input: json.RawMessage(`{"prompt":"Research"}`)})
	if err != nil || spawn.IsError || spawn.ChildID == "" {
		t.Fatalf("spawn=%+v error=%v", spawn, err)
	}
	unknown, err := (tool.WaitChild{}).Run(ctx, tool.Call{Env: env, Input: json.RawMessage(`{"id":"not-owned"}`)})
	if err != nil || !unknown.IsError {
		t.Fatal("unowned child was accepted")
	}
	input, _ := json.Marshal(map[string]event.ID{"id": spawn.ChildID})
	waitCtx, stop := context.WithCancel(ctx)
	stop()
	if _, err := (tool.WaitChild{}).Run(waitCtx, tool.Call{Env: env, Input: input}); err == nil {
		t.Fatal("waiting ignored cancellation")
	}
	close(release)
	result, err := (tool.WaitChild{}).Run(ctx, tool.Call{Env: env, Input: input})
	if err != nil || result.IsError || len(runner.Poll()) != 1 {
		t.Fatalf("wait=%+v error=%v", result, err)
	}
}
