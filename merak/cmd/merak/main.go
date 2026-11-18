// Command merak is the MerakCode command line and engine.
package main

import (
	"os"

	"github.com/TongTong313/merakcode/merak/cli"
)

func main() {
	os.Exit(cli.Run(os.Args[1:], os.Stdin, os.Stdout))
}
