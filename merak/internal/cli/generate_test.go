package cli

import (
	"bytes"
	"encoding/json"
	"strings"
	"testing"

	"github.com/TongTong313/merakcode/merak/protocol"
)

func TestGeneratePrintsTheProtocolSchemaAsJSON(t *testing.T) {
	t.Setenv("MERAKCODE_HOME", t.TempDir())
	var out bytes.Buffer
	if code := Run([]string{"generate"}, strings.NewReader(""), &out); code != 0 {
		t.Fatalf("code=%d output=%s", code, out.String())
	}
	var document struct {
		Schema   string                     `json:"$schema"`
		Protocol int                        `json:"x-protocol"`
		Methods  map[string]json.RawMessage `json:"x-methods"`
		Events   map[string]json.RawMessage `json:"x-events"`
	}
	if err := json.Unmarshal(out.Bytes(), &document); err != nil {
		t.Fatalf("output is not JSON: %v", err)
	}
	if document.Protocol != protocol.Version || document.Schema == "" {
		t.Errorf("protocol=%d schema=%q", document.Protocol, document.Schema)
	}
	if len(document.Methods["hello"]) == 0 {
		t.Error("the schema lacks the hello method")
	}
	if len(document.Events["turn.finished"]) == 0 {
		t.Error("the schema lacks the turn.finished event")
	}
}

func TestGenerateRejectsArguments(t *testing.T) {
	var out bytes.Buffer
	if code := Run([]string{"generate", "extra"}, strings.NewReader(""), &out); code != 2 {
		t.Fatalf("code=%d", code)
	}
}
