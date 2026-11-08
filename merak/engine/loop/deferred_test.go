package loop_test

import (
	"bytes"
	"context"
	"encoding/json"
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
	"github.com/TongTong313/merakcode/merak/engine/permission"
	"github.com/TongTong313/merakcode/merak/engine/session"
	"github.com/TongTong313/merakcode/merak/engine/tool"
)

func TestDeferredToolsLoadValidateAndRequirePermissionWithFrozenSpecs(t *testing.T) {
	dir := t.TempDir()
	approvals := 0
	gate := &permission.Gate{Policy: permission.Policy{Mode: permission.ModeAsk}, Ask: func(_ context.Context, request permission.Request) (permission.Reply, error) {
		approvals++
		if request.Spec.Effect != tool.EffectWrite || request.Call.Name != "write_file" {
			return permission.Reply{}, fmt.Errorf("approval did not describe the actual operation")
		}
		return permission.Reply{Decision: permission.Allow}, nil
	}}
	pool := &tool.Pool{Name: "test", Deferred: map[string]tool.Tool{"write_file": gate.Wrap(tool.WriteFile{}), "read_file": gate.Wrap(tool.ReadFile{})}}
	var frozen []byte
	check := func(req model.Request) error {
		data, err := json.Marshal(req.Tools)
		if err != nil {
			return err
		}
		if frozen == nil {
			frozen = data
		}
		if !bytes.Equal(data, frozen) || bytes.Contains(data, []byte(`"name":"write_file"`)) {
			return fmt.Errorf("provider tool list changed or exposed deferred schemas")
		}
		return nil
	}
	resultCheck := func(failed bool) func(model.Request) error {
		return func(req model.Request) error {
			if err := check(req); err != nil {
				return err
			}
			result := req.Messages[len(req.Messages)-1].Parts[0].ToolResult
			if result == nil || result.IsError != failed {
				return fmt.Errorf("unexpected deferred result: %+v", result)
			}
			return nil
		}
	}
	call := func(id, name, input string) []model.ToolCall {
		return []model.ToolCall{{ID: id, Name: name, Input: []byte(input)}}
	}
	provider := fake.New(t,
		fake.Reply{Calls: call("unloaded", "call_tool", `{"name":"write_file","input":{"path":"out.txt","content":"unloaded"}}`), Expect: check},
		fake.Reply{Calls: call("load", "load_tools", `{"names":["read_file","write_file"]}`), Expect: resultCheck(true)},
		fake.Reply{Calls: call("invalid", "call_tool", `{"name":"read_file","input":{}}`), Expect: func(req model.Request) error {
			if err := resultCheck(false)(req); err != nil {
				return err
			}
			var specs []tool.Spec
			if err := json.Unmarshal([]byte(req.Messages[len(req.Messages)-1].Parts[0].ToolResult.Parts[0].Text), &specs); err != nil {
				return err
			}
			if len(specs) != 2 || specs[0].Name != "read_file" || specs[1].Name != "write_file" || !json.Valid(specs[0].Input) {
				return fmt.Errorf("load did not return a schema")
			}
			return nil
		}},
		fake.Reply{Calls: call("valid", "call_tool", `{"name":"write_file","input":{"path":"out.txt","content":"approved"}}`), Expect: func(req model.Request) error {
			if err := resultCheck(true)(req); err != nil {
				return err
			}
			direct, err := (tool.ReadFile{}).Run(context.Background(), tool.Call{Input: []byte(`{}`), Env: tool.Env{Workdir: dir}})
			if err != nil {
				return err
			}
			result := req.Messages[len(req.Messages)-1].Parts[0].ToolResult
			if !reflect.DeepEqual(result.Parts, direct.Parts) || len(result.Parts) == 0 || result.Parts[0].Text == "" {
				return fmt.Errorf("deferred validation differs from direct validation")
			}
			return nil
		}},
		fake.Reply{Text: "Written.", Expect: resultCheck(false)},
	)
	runner := loop.Loop{Model: provider, Bus: event.NewBus(nil, time.Now, event.NewID), Tools: pool, Env: tool.Env{Workdir: dir}}
	state := session.State{ID: "deferred-chat"}
	if _, err := runner.RunTurn(context.Background(), &state, loop.Input{Parts: []model.Part{{Text: "Use the deferred writer"}}}); err != nil {
		t.Fatal(err)
	}
	body, err := os.ReadFile(filepath.Join(dir, "out.txt"))
	if err != nil || string(body) != "approved" || approvals != 1 {
		t.Fatalf("body=%q approvals=%d error=%v", body, approvals, err)
	}
	other := pool.With()
	meta, ok := other.Lookup("call_tool")
	if !ok {
		t.Fatal("missing call_tool")
	}
	result, err := meta.Run(context.Background(), tool.Call{Input: []byte(`{"name":"write_file","input":{"path":"out.txt","content":"another session"}}`), Env: tool.Env{Workdir: dir}})
	if err != nil || !result.IsError {
		t.Fatalf("loaded tools escaped the session: %+v %v", result, err)
	}
}
