// Command localserver is a local MCP server with two read tools, for tests that need a real one.
package main

import (
	"context"
	"os"

	"github.com/TongTong313/merakcode/merak/engine/mcp"
	"github.com/TongTong313/merakcode/merak/engine/tool"
)

func main() {
	server := &mcp.Server{Tools: tool.NewPool("fixture", tool.ReadFile{}, tool.ListDir{}), Env: tool.Env{Workdir: "."}}
	if err := server.Serve(context.Background(), os.Stdin, os.Stdout); err != nil {
		os.Exit(1)
	}
}
