package cli

import (
	"context"
	"flag"
	"io"
	"os"
	"os/signal"
	"syscall"

	"github.com/TongTong313/merakcode/merak/protocol"
)

func runMCP(args []string, input io.Reader, output io.Writer) int {
	flags := flag.NewFlagSet("mcp", flag.ContinueOnError)
	flags.SetOutput(io.Discard)
	claim, thread, role := flags.String("claim", "", ""), flags.String("thread", "", ""), flags.String("as", "", "")
	if flags.Parse(args) != nil || flags.NArg() != 0 {
		return 2
	}
	scope := *claim
	if *role == "leader" {
		scope = *thread
	}
	if scope == "" || *claim != "" && *thread != "" || *role != "worker" && *role != "leader" {
		return 2
	}
	ctx, cancel := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer cancel()
	connection, err := protocol.ConnectMCP(ctx, os.Getenv("MERAKCODE_MCP_ADDRESS"), os.Getenv("MERAKCODE_MCP_TOKEN"), *role, scope)
	if err != nil {
		return 1
	}
	defer connection.Close()
	stop := context.AfterFunc(ctx, func() { connection.Close() })
	defer stop()
	go func() { _, _ = io.Copy(connection, input); connection.Close() }()
	if _, err := io.Copy(output, connection); err != nil && ctx.Err() == nil {
		return 1
	}
	return 0
}
