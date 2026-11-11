package server_test

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/TongTong313/merakcode/merak/engine"
	"github.com/TongTong313/merakcode/merak/engine/model"
	"github.com/TongTong313/merakcode/merak/engine/model/fake"
	"github.com/TongTong313/merakcode/merak/engine/permission"
	"github.com/TongTong313/merakcode/merak/engine/tool"
	"github.com/TongTong313/merakcode/merak/internal/server"
	"github.com/TongTong313/merakcode/merak/protocol"
)

// serveClientTool answers every tool.call the engine sends to the client with a fixed text.
func serveClientTool(ctx context.Context, client *protocol.Client, answer func(protocol.ToolCallParams) protocol.ToolResultParams) {
	for message := range client.Notifications {
		if message.Method != "tool.call" {
			continue
		}
		var call protocol.ToolCallParams
		if json.Unmarshal(message.Params, &call) != nil {
			continue
		}
		result := answer(call)
		result.Call = call.Call
		_ = client.Call(ctx, "tool.result", result, nil)
	}
}

func TestAClientRegistersAToolTheModelCallsAndTheCallFailsOnceTheClientIsGone(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	var client *protocol.Client
	var e *engine.Engine
	var execAsks int
	provider := fake.New(t,
		fake.Reply{Calls: []model.ToolCall{{ID: "load", Name: "load_tools", Input: []byte(`{"names":["client__weather"]}`)}}, Expect: func(req model.Request) error {
			if !strings.Contains(req.System, "client__weather") {
				return fmt.Errorf("the registered tool is not listed as a deferred tool")
			}
			return nil
		}},
		fake.Reply{Calls: []model.ToolCall{{ID: "call", Name: "call_tool", Input: []byte(`{"name":"client__weather","input":{"city":"Paris"}}`)}}},
		fake.Reply{Calls: []model.ToolCall{{ID: "again", Name: "call_tool", Input: []byte(`{"name":"client__weather","input":{"city":"Rome"}}`)}}, Expect: func(req model.Request) error {
			result := req.Messages[len(req.Messages)-1].Parts[0].ToolResult
			if result == nil || result.IsError || result.Parts[0].Text != "Sunny in Paris" {
				return fmt.Errorf("the client result did not reach the model: %+v", result)
			}
			client.Close()
			deadline := time.Now().Add(5 * time.Second)
			for len(e.ClientTools()) > 0 {
				if time.Now().After(deadline) {
					return fmt.Errorf("the tool outlived its connection")
				}
				time.Sleep(10 * time.Millisecond)
			}
			return nil
		}},
		fake.Reply{Text: "Done.", Expect: func(req model.Request) error {
			result := req.Messages[len(req.Messages)-1].Parts[0].ToolResult
			if result == nil || !result.IsError || !strings.Contains(result.Parts[0].Text, "doesn't exist") {
				return fmt.Errorf("a call after the disconnect did not fail: %+v", result)
			}
			return nil
		}},
	)
	e, err := engine.New(engine.Deps{Workdir: t.TempDir(), Providers: map[string]model.Provider{"fake": provider},
		Ask: func(_ context.Context, request permission.Request) (permission.Reply, error) {
			if request.Spec.Name == "client__weather" && request.Spec.Effect == tool.EffectExec {
				execAsks++
			}
			return permission.Reply{Decision: permission.Allow}, nil
		}})
	if err != nil {
		t.Fatal(err)
	}
	handler := server.New(e, "token")
	defer handler.Close()
	host := httptest.NewServer(handler)
	defer host.Close()
	client, err = protocol.Connect(ctx, "ws"+strings.TrimPrefix(host.URL, "http"), "token", protocol.HelloParams{Protocol: 1, Client: protocol.ClientInfo{Name: "test", Version: "1"}})
	if err != nil {
		t.Fatal(err)
	}
	defer client.Close()
	go serveClientTool(ctx, client, func(call protocol.ToolCallParams) protocol.ToolResultParams {
		var input struct {
			City string `json:"city"`
		}
		_ = json.Unmarshal(call.Input, &input)
		return protocol.ToolResultParams{Text: "Sunny in " + input.City}
	})
	register := protocol.ToolRegisterParams{Name: "weather", Description: "Report the weather of a city.", Schema: json.RawMessage(`{"type":"object","properties":{"city":{"type":"string"}},"required":["city"]}`)}
	if err := client.Call(ctx, "tool.register", register, nil); err != nil {
		t.Fatal(err)
	}
	if _, err := e.Chat(ctx, "fake", "What is the weather?"); err != nil {
		t.Fatal(err)
	}
	if execAsks != 2 {
		t.Fatalf("an exec tool was asked about %d times, want once for each of the two calls", execAsks)
	}
}

func TestAClientToolIsAskedAboutByItsEffectAndOnlyItsOwnerMayChangeIt(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	var asked []permission.Request
	provider := fake.New(t,
		fake.Reply{Calls: []model.ToolCall{{ID: "load", Name: "load_tools", Input: []byte(`{"names":["client__lookup"]}`)}}},
		fake.Reply{Calls: []model.ToolCall{{ID: "call", Name: "call_tool", Input: []byte(`{"name":"client__lookup","input":{}}`)}}},
		fake.Reply{Text: "Done."},
	)
	e, err := engine.New(engine.Deps{Workdir: t.TempDir(), Providers: map[string]model.Provider{"fake": provider},
		Ask: func(_ context.Context, request permission.Request) (permission.Reply, error) {
			asked = append(asked, request)
			return permission.Reply{Decision: permission.Allow}, nil
		}})
	if err != nil {
		t.Fatal(err)
	}
	handler := server.New(e, "token")
	defer handler.Close()
	host := httptest.NewServer(handler)
	defer host.Close()
	connect := func() *protocol.Client {
		client, err := protocol.Connect(ctx, "ws"+strings.TrimPrefix(host.URL, "http"), "token", protocol.HelloParams{Protocol: 1, Client: protocol.ClientInfo{Name: "test", Version: "1"}})
		if err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() { client.Close() })
		return client
	}
	owner, other := connect(), connect()
	go serveClientTool(ctx, owner, func(protocol.ToolCallParams) protocol.ToolResultParams {
		return protocol.ToolResultParams{Text: "found"}
	})
	register := protocol.ToolRegisterParams{Name: "lookup", Description: "Look a word up.", Effect: "read"}
	if err := owner.Call(ctx, "tool.register", register, nil); err != nil {
		t.Fatal(err)
	}
	if err := other.Call(ctx, "tool.register", register, nil); err == nil {
		t.Fatal("a second client took over a registered tool")
	}
	if err := other.Call(ctx, "tool.register", protocol.ToolRegisterParams{Name: "bad name", Description: "x"}, nil); err == nil {
		t.Fatal("an invalid tool name was accepted")
	}
	if err := other.Call(ctx, "tool.unregister", protocol.ToolUnregisterParams{Name: "lookup"}, nil); err != nil {
		t.Fatal(err)
	}
	if names := e.ClientTools(); len(names) != 1 || names[0] != "client__lookup" {
		t.Fatalf("another client removed the tool: %v", names)
	}
	if _, err := e.Chat(ctx, "fake", "Look it up"); err != nil {
		t.Fatal(err)
	}
	for _, request := range asked {
		if request.Spec.Name == "client__lookup" {
			t.Fatalf("a read tool was asked about: %+v", request)
		}
	}
	if err := owner.Call(ctx, "tool.unregister", protocol.ToolUnregisterParams{Name: "lookup"}, nil); err != nil {
		t.Fatal(err)
	}
	if names := e.ClientTools(); len(names) != 0 {
		t.Fatalf("the owner could not remove its tool: %v", names)
	}
}
