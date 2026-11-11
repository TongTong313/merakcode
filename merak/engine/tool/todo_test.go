package tool_test

import (
	"context"
	"strings"
	"testing"

	"github.com/TongTong313/merakcode/merak/engine/tool"
)

func TestTodoWriteAcceptsAWholeListAndRejectsBadStatuses(t *testing.T) {
	for _, c := range []struct {
		name, input string
		fail        bool
	}{
		{"valid list", `{"items":[{"content":"Read the code","status":"done"},{"content":"Fix it","status":"in_progress"},{"content":"Test it","status":"pending"}]}`, false},
		{"empty list clears", `{"items":[]}`, false},
		{"unknown status", `{"items":[{"content":"Fix it","status":"started"}]}`, true},
		{"blank content", `{"items":[{"content":"  ","status":"pending"}]}`, true},
		{"two items in progress", `{"items":[{"content":"A","status":"in_progress"},{"content":"B","status":"in_progress"}]}`, true},
		{"extra field", `{"items":[],"other":1}`, true},
	} {
		t.Run(c.name, func(t *testing.T) {
			result, err := (tool.TodoWrite{}).Run(context.Background(), tool.Call{Input: []byte(c.input)})
			if err != nil || result.IsError != c.fail {
				t.Fatalf("result=%+v err=%v", result, err)
			}
			if c.fail && !strings.Contains(result.Parts[0].Text, "todo") {
				t.Fatalf("the error does not explain itself: %q", result.Parts[0].Text)
			}
		})
	}
	if spec := (tool.TodoWrite{}).Spec(); spec.Name != "todo_write" || spec.Effect != tool.EffectRead {
		t.Fatalf("spec=%+v", spec)
	}
}
