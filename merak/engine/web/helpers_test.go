package web_test

import (
	"strings"

	"github.com/TongTong313/merakcode/merak/engine/tool"
)

// text joins the text parts of a tool result.
func text(result tool.Result) string {
	var all strings.Builder
	for _, part := range result.Parts {
		all.WriteString(part.Text)
	}
	return all.String()
}
