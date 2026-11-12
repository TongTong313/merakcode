// Command gen derives the protocol schema from Go wire types and registered event payloads.
package main

import (
	"fmt"
	"os"

	"github.com/TongTong313/merakcode/merak/protocol/schema"
)

func main() {
	if err := schema.WriteDocument(os.Stdout); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}
