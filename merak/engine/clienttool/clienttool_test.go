package clienttool_test

import (
	"context"
	"encoding/json"
	"strings"
	"testing"

	"github.com/TongTong313/merakcode/merak/engine/clienttool"
	"github.com/TongTong313/merakcode/merak/engine/tool"
)

func answer(context.Context, string, json.RawMessage) (string, bool, error) { return "ok", false, nil }

func TestRegisterRefusesWhatCannotBeOfferedToAModel(t *testing.T) {
	for _, test := range []struct {
		name       string
		definition clienttool.Definition
		wantError  string
	}{
		{"name with a space", clienttool.Definition{Name: "two words", Description: "x"}, "tool name"},
		{"empty description", clienttool.Definition{Name: "a"}, "description"},
		{"schema that is not an object", clienttool.Definition{Name: "a", Description: "x", Schema: json.RawMessage(`{"type":"string"}`)}, "schema"},
		{"unknown effect", clienttool.Definition{Name: "a", Description: "x", Effect: "teleport"}, "effect"},
		{"valid", clienttool.Definition{Name: "a", Description: "x", Effect: tool.EffectRead}, ""},
	} {
		t.Run(test.name, func(t *testing.T) {
			err := clienttool.New().Register("owner", test.definition, answer)
			if test.wantError == "" && err != nil || test.wantError != "" && (err == nil || !strings.Contains(err.Error(), test.wantError)) {
				t.Fatalf("error = %v, want one about %q", err, test.wantError)
			}
		})
	}
}

func TestAToolOfADroppedOwnerFailsWithoutReachingItsHandler(t *testing.T) {
	registry := clienttool.New()
	if err := registry.Register("owner", clienttool.Definition{Name: "a", Description: "x"}, func(context.Context, string, json.RawMessage) (string, bool, error) {
		t.Error("the handler of a dropped owner ran")
		return "", false, nil
	}); err != nil {
		t.Fatal(err)
	}
	listed := registry.Tools()
	if len(listed) != 1 || listed[0].Spec().Name != "client__a" || listed[0].Spec().Effect != tool.EffectExec {
		t.Fatalf("tools = %+v", listed)
	}
	registry.Drop("owner")
	result, err := listed[0].Run(t.Context(), tool.Call{Input: json.RawMessage(`{}`)})
	if err != nil || !result.IsError || !strings.Contains(result.Parts[0].Text, "doesn't exist") {
		t.Fatalf("result = %+v, error = %v", result, err)
	}
}
