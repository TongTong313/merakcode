// Package cli runs one merak command line.
package cli

import (
	"fmt"
	"io"

	"github.com/TongTong313/merakcode/merak"
)

// Run executes the command line in args and returns the process exit code. The engine emits no text meant for
// users (clients render events and error codes), so --version is the only output for now.
func Run(args []string, stdout io.Writer) int {
	if len(args) == 1 && args[0] == "--version" {
		fmt.Fprintln(stdout, merak.Version())
		return 0
	}
	return 2
}
