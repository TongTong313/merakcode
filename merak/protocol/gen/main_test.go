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
	for _, name := range []string{"hello", "session.create", "session.send", "session.cancel", "events.subscribe", "store.append", "store.read", "store.find", "store.get", "store.put", "store.fetch", "store.list"} {
		if len(schema.Methods[name]) == 0 {
			t.Errorf("missing method %s", name)
		}
	}
	var bodySchema struct {
		AnyOf []struct {
			Type string `json:"type"`
		} `json:"anyOf"`
	}
	if err := json.Unmarshal(schema.Defs["StoreDoc"].Properties["body"], &bodySchema); err != nil || len(bodySchema.AnyOf) != 2 || bodySchema.AnyOf[0].Type != "string" {
		t.Fatalf("document bytes must use JSON base64 strings: %s", schema.Defs["StoreDoc"].Properties["body"])
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
