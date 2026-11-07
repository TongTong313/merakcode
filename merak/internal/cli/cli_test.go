package cli

import (
	"bytes"
	"testing"

	"github.com/TongTong313/merakcode/merak"
)

func TestRun(t *testing.T) {
	tests := []struct {
		name   string
		args   []string
		code   int
		output string
	}{
		{name: "prints the version", args: []string{"--version"}, code: 0, output: merak.Version() + "\n"},
		{name: "rejects other arguments", args: []string{"serve"}, code: 2},
		{name: "rejects no arguments", args: nil, code: 2},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			var output bytes.Buffer
			if code := Run(test.args, &output); code != test.code {
				t.Errorf("Run(%q) = %d, want %d", test.args, code, test.code)
			}
			if output.String() != test.output {
				t.Errorf("Run(%q) printed %q, want %q", test.args, output.String(), test.output)
			}
		})
	}
}
