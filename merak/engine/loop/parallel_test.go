package loop_test

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"reflect"
	"testing"
	"time"

	"github.com/TongTong313/merakcode/merak/engine/event"
	"github.com/TongTong313/merakcode/merak/engine/loop"
	"github.com/TongTong313/merakcode/merak/engine/model"
	"github.com/TongTong313/merakcode/merak/engine/model/fake"
	"github.com/TongTong313/merakcode/merak/engine/session"
	"github.com/TongTong313/merakcode/merak/engine/tool"
)

type coordinatedRead struct {
	arrived chan struct{}
	ready   <-chan struct{}
}

func (coordinatedRead) Spec() tool.Spec { return (tool.ReadFile{}).Spec() }

func (r coordinatedRead) Run(ctx context.Context, call tool.Call) (tool.Result, error) {
	result, err := (tool.ReadFile{}).Run(ctx, call)
	if err != nil {
		return result, err
	}
	r.arrived <- struct{}{}
	select {
	case <-r.ready:
		return result, nil
	case <-ctx.Done():
		return tool.Result{}, ctx.Err()
	}
}

func TestReadToolsOverlapAndPublishResultsInCallOrder(t *testing.T) {
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "notes.txt"), []byte("parallel reads"), 0o600); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	arrived, ready := make(chan struct{}, 2), make(chan struct{})
	go func() {
		for range 2 {
			select {
			case <-arrived:
			case <-ctx.Done():
				return
			}
		}
		close(ready)
	}()
	bus := event.NewBus(nil, time.Now, event.NewID)
	events, unsubscribe := bus.Subscribe(event.Filter{})
	defer unsubscribe()
	provider := fake.New(t,
		fake.Reply{Calls: []model.ToolCall{{ID: "first", Name: "read_file", Input: []byte(`{"path":"notes.txt"}`)}, {ID: "second", Name: "read_file", Input: []byte(`{"path":"notes.txt"}`)}}},
		fake.Reply{Text: "Read both.", Expect: func(req model.Request) error {
			parts := req.Messages[len(req.Messages)-1].Parts
			if len(parts) != 2 || parts[0].ToolResult.CallID != "first" || parts[1].ToolResult.CallID != "second" {
				return fmt.Errorf("results are not grouped in call order")
			}
			return nil
		}},
	)
	runner := loop.Loop{Model: provider, Bus: bus, Tools: tool.NewPool("test", coordinatedRead{arrived: arrived, ready: ready}), Env: tool.Env{Workdir: dir}}
	state := session.State{ID: "parallel-chat"}
	if _, err := runner.RunTurn(ctx, &state, loop.Input{Parts: []model.Part{{Text: "Read twice"}}}); err != nil {
		t.Fatal(err)
	}
	unsubscribe()
	var order []string
	for e := range events {
		switch e.Type {
		case tool.Called:
			call, err := event.Decode[model.ToolCall](e)
			if err != nil {
				t.Fatal(err)
			}
			order = append(order, "called:"+call.ID)
		case tool.Completed:
			result, err := event.Decode[tool.Completion](e)
			if err != nil {
				t.Fatal(err)
			}
			order = append(order, "completed:"+result.CallID)
		}
	}
	if !reflect.DeepEqual(order, []string{"called:first", "called:second", "completed:first", "completed:second"}) {
		t.Fatalf("event order = %v", order)
	}
}
