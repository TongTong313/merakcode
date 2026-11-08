package tool_test

import (
	"context"
	"testing"

	"github.com/TongTong313/merakcode/merak/engine/store"
	"github.com/TongTong313/merakcode/merak/engine/store/memory"
	"github.com/TongTong313/merakcode/merak/engine/tool"
)

func TestLookupReadsOneBasedInclusiveLineRanges(t *testing.T) {
	docs := memory.New()
	if err := docs.Put(context.Background(), store.Doc{Kind: "blob", Key: "output", Body: []byte("first\nsecond\nthird\nfourth\n")}); err != nil {
		t.Fatal(err)
	}
	for _, test := range []struct {
		name, input, want string
		failed            bool
	}{
		{"range arguments", `{"ref":"mrk://blob/output","startLine":2,"endLine":3}`, "second\nthird", false},
		{"range reference", `{"ref":"mrk://blob/output?lines=2-3"}`, "second\nthird", false},
		{"invalid range", `{"ref":"mrk://blob/output","startLine":3,"endLine":2}`, "", true},
		{"missing blob", `{"ref":"mrk://blob/absent"}`, "", true},
		{"wrong kind", `{"ref":"file:///output"}`, "", true},
	} {
		t.Run(test.name, func(t *testing.T) {
			result, err := (tool.Lookup{Store: docs}).Run(context.Background(), tool.Call{Input: []byte(test.input)})
			if err != nil || result.IsError != test.failed || !test.failed && result.Parts[0].Text != test.want {
				t.Fatalf("lookup=%+v error=%v", result, err)
			}
		})
	}
}
