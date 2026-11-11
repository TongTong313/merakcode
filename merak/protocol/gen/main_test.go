package main_test

import (
	"encoding/json"
	"os/exec"
	"testing"
)

func TestGeneratorDescribesMethodsAndTypedEventPayloads(t *testing.T) {
	body, err := exec.Command("go", "run", ".").CombinedOutput()
	if err != nil {
		t.Fatalf("generator: %v\n%s", err, body)
	}
	var schema struct {
		Defs map[string]struct {
			Properties map[string]json.RawMessage `json:"properties"`
		} `json:"$defs"`
		Methods map[string]json.RawMessage `json:"x-methods"`
		Events  map[string]json.RawMessage `json:"x-events"`
	}
	if err := json.Unmarshal(body, &schema); err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{"hello", "session.create", "session.send", "session.cancel", "events.subscribe", "engine.status", "events.find"} {
		if len(schema.Methods[name]) == 0 {
			t.Errorf("missing method %s", name)
		}
	}
	for _, name := range []string{"store.append", "store.read", "store.find", "store.get", "store.put", "store.fetch", "store.list"} {
		if len(schema.Methods[name]) != 0 {
			t.Errorf("the engine no longer asks its client to host its storage, but %s is in the protocol", name)
		}
	}
	if len(schema.Defs["ProtocolSessionSendParams"].Properties["parts"]) == 0 {
		t.Fatal("message parts are missing")
	}
	if len(schema.Defs["SessionCompletion"].Properties["usage"]) == 0 || len(schema.Defs["SessionCompletion"].Properties["parts"]) == 0 {
		t.Fatal("completed message fields were not flattened")
	}
	for _, name := range []string{"message.delta", "message.completed", "tool.completed", "turn.finished", "permission.requested"} {
		if len(schema.Events[name]) == 0 {
			t.Errorf("missing event %s", name)
		}
	}
}
