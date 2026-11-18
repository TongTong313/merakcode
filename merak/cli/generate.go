package cli

import (
	"io"

	"github.com/TongTong313/merakcode/merak/protocol/schema"
)

// generateCommand runs merak generate: the JSON Schema of the protocol on standard output. It needs no engine.
func generateCommand(args []string, output io.Writer) int {
	if len(args) != 0 {
		return 2
	}
	if schema.WriteDocument(output) != nil {
		return 1
	}
	return 0
}
