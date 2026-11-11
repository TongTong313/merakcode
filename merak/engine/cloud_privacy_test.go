package engine_test

import (
	"context"
	"encoding/json"
	"strings"
	"testing"
	"time"

	"github.com/TongTong313/merakcode/merak/engine"
	"github.com/TongTong313/merakcode/merak/engine/event"
	"github.com/TongTong313/merakcode/merak/engine/group"
	"github.com/TongTong313/merakcode/merak/engine/loop"
	"github.com/TongTong313/merakcode/merak/engine/model"
	"github.com/TongTong313/merakcode/merak/engine/permission"
	"github.com/TongTong313/merakcode/merak/engine/session"
	"github.com/TongTong313/merakcode/merak/engine/store"
	"github.com/TongTong313/merakcode/merak/engine/store/memory"
	"github.com/TongTong313/merakcode/merak/engine/tool"
	"github.com/TongTong313/merakcode/merak/internal/cloud"
	"github.com/TongTong313/merakcode/merak/internal/testcloud"
	"github.com/TongTong313/merakcode/merak/protocol"
)

func TestCloudGroupsNameAgentsByIdAndNeverSendTheirDefinitions(t *testing.T) {
	ctx, cancel := context.WithTimeout(t.Context(), 8*time.Second)
	defer cancel()
	peer := testcloud.New(t)
	peer.Handle = func(req protocol.Message) (any, error) {
		if req.Method == "group.create" {
			if strings.Contains(string(req.Params), "profiles") || strings.Contains(string(req.Params), "CUSTOM_KEY") {
				t.Error("an agent definition left the device")
			}
			if !strings.Contains(string(req.Params), `"agent":"agent-1"`) {
				t.Error("the member does not name its agent by id")
			}
			return group.Group{ID: "cloud-group", Kind: group.KindCloud}, nil
		}
		return nil, nil
	}
	e, err := engine.New(engine.Deps{Workdir: t.TempDir()})
	if err != nil {
		t.Fatal(err)
	}
	defer e.Close()
	if err := e.ConnectCloud(ctx, peer.Credentials()); err != nil {
		t.Fatal(err)
	}
	params, _ := json.Marshal(protocol.GroupCreateParams{Group: group.Group{Kind: group.KindCloud}, Members: []group.Member{{ID: "lead", Name: "Lead", Kind: group.MemberAgent, AgentRole: group.AgentLeader, Agent: "agent-1"}}})
	if _, handled, err := e.ForwardCloud(ctx, "group.create", params); err != nil || !handled {
		t.Fatalf("forward handled=%t err=%v", handled, err)
	}
}

func TestCloudUploadKeepsFileMetadataWithoutUploadingFileBodies(t *testing.T) {
	ctx, cancel := context.WithTimeout(t.Context(), 8*time.Second)
	defer cancel()
	peer := testcloud.New(t)
	storage := memory.New()
	marshal := func(value any) json.RawMessage { body, _ := json.Marshal(value); return body }
	read := model.ToolCall{ID: "read", Name: "read_file", Input: json.RawMessage(`{"path":"source.go"}`)}
	write := model.ToolCall{ID: "write", Name: "write_file", Input: json.RawMessage(`{"path":"source.go","content":"private-file-body\nsecond line\n"}`)}
	facts := []event.Event{
		{ID: "created", Type: session.Created, Payload: marshal(session.State{System: "private-file-body from project rules"})},
		{ID: "read-call", Type: tool.Called, Payload: marshal(read)},
		{ID: "read-result", Type: tool.Completed, Cause: "read-call", Payload: marshal(tool.Completion{CallID: "read", Name: "read_file", Result: tool.Result{Parts: []model.Part{{Text: "private-file-body\nsecond line\n"}}}})},
		{ID: "write-call", Type: tool.Called, Payload: marshal(write)},
		{ID: "approval", Type: permission.Requested, Payload: marshal(permission.Request{Call: tool.Call{ID: write.ID, Name: write.Name, Input: write.Input}})},
		{ID: "message", Type: session.MessageCompleted, Payload: marshal(session.Completion{Message: model.Message{Role: model.Assistant, Parts: []model.Part{{ToolCall: &write}}}})},
		{ID: "grep-call", Type: tool.Called, Payload: marshal(model.ToolCall{ID: "grep", Name: "grep", Input: json.RawMessage(`{"path":"source.go","pattern":"private"}`)})},
		{ID: "grep-result", Type: tool.Completed, Cause: "grep-call", Payload: marshal(tool.Completion{CallID: "grep", Name: "grep", Result: tool.Result{Parts: []model.Part{{Text: "source.go:4:private-file-body\nsource.go:8:second line"}}}})},
		{ID: "tool-message", Type: session.MessageSent, Payload: marshal(model.Message{Role: model.Tool, Parts: []model.Part{{ToolResult: &model.ToolResult{CallID: "read", Parts: []model.Part{{Text: "private-file-body"}}}}}})},
		{ID: "turn-result", Type: loop.TurnFinished, Payload: marshal(loop.Outcome{Final: []model.Part{{ToolCall: &write}}})},
		{ID: "external-progress", Type: tool.Progressed, Payload: marshal(tool.Progress{Raw: json.RawMessage(`{"path":"source.go","content":[{"type":"diff","oldText":"private-file-body","newText":"private-file-body"}]}`)})},
		{ID: "external-write", Type: tool.Called, Payload: marshal(model.ToolCall{ID: "external", Name: "apply_patch", Input: json.RawMessage(`{"changes":[{"path":"source.go","diff":"private-file-body"}]}`)})},
		{ID: "external-read-call", Type: tool.Called, Payload: marshal(model.ToolCall{ID: "external-read", Name: "readFile", Input: json.RawMessage(`{"path":"source.go"}`)})},
		{ID: "external-read-result", Type: tool.Completed, Cause: "external-read-call", Payload: marshal(tool.Completion{CallID: "external-read", Name: "readFile", Result: tool.Result{Parts: []model.Part{{Text: "private-file-body"}}}})},
		{ID: "shell-call", Type: tool.Called, Payload: marshal(model.ToolCall{ID: "shell", Name: "bash", Input: json.RawMessage(`{"path":"source.go","command":"printf 'private-file-body' > source.go"}`)})},
		{ID: "shell-result", Type: tool.Completed, Cause: "shell-call", Payload: marshal(tool.Completion{CallID: "shell", Name: "bash", Result: tool.Result{Parts: []model.Part{{Text: "private-file-body"}}}})},
		{ID: "external-output", Type: tool.Progressed, Payload: marshal(tool.Progress{Raw: json.RawMessage(`{"path":"source.go","aggregatedOutput":"private-file-body"}`)})},
		{ID: "external-partial", Type: tool.Progressed, Payload: marshal(tool.Progress{Raw: json.RawMessage(`{"path":"source.go","partial_json":"private-file-body","delta":"private-file-body","unknown_field":"private-file-body"}`)})},
	}
	for i := range facts {
		facts[i].Stream, facts[i].Seq, facts[i].Time = "session:privacy", uint64(i+1), time.Now()
		facts[i].Scope.Session = "privacy"
	}
	if err := storage.Append(ctx, facts); err != nil {
		t.Fatal(err)
	}
	if err := storage.Put(ctx, store.Doc{Kind: "cloud-stream", Key: "session:privacy", Body: []byte(`0`), Meta: map[string]string{"host": cloud.Identity(peer.Credentials())}}); err != nil {
		t.Fatal(err)
	}
	e, err := engine.New(engine.Deps{Store: storage, Workdir: t.TempDir()})
	if err != nil {
		t.Fatal(err)
	}
	defer e.Close()
	if err := e.ConnectCloud(ctx, peer.Credentials()); err != nil {
		t.Fatal(err)
	}
	if err := e.DisconnectCloud(ctx); err != nil {
		t.Fatal(err)
	}
	for _, original := range facts {
		select {
		case got := <-peer.Published:
			if got.ID != original.ID || got.Seq != original.Seq || got.Cause != original.Cause {
				t.Fatal("event identity changed")
			}
			if strings.Contains(string(got.Payload), "private-file-body") {
				t.Errorf("%s uploaded a file body", got.Type)
			}
			if got.Type != session.Created && !strings.Contains(string(got.Payload), "source.go") {
				t.Errorf("%s lost the file path", got.Type)
			}
			if got.Type == tool.Completed && !strings.Contains(string(got.Payload), "lines") {
				t.Error("file line count missing")
			}
		case <-ctx.Done():
			t.Fatal(ctx.Err())
		}
	}
	saved, err := e.GetEvent(ctx, "read-result")
	if err != nil || !strings.Contains(string(saved.Payload), "private-file-body") {
		t.Fatal("cloud projection changed local history")
	}
}
