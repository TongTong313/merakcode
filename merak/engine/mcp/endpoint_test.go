package mcp_test

import (
	"context"
	"testing"
	"time"

	"github.com/TongTong313/merakcode/merak/engine/mcp"
	"github.com/TongTong313/merakcode/merak/engine/tool"
	"github.com/TongTong313/merakcode/merak/protocol"
)

func TestMemberEndpointRequiresItsOwnTokenAndScope(t *testing.T) {
	ctx, cancel := context.WithTimeout(t.Context(), 5*time.Second)
	defer cancel()
	endpoint, err := mcp.Listen(ctx, &mcp.Server{Tools: tool.NewPool("worker", tool.SubmitReport{})}, "worker", "claim-1")
	if err != nil {
		t.Fatal(err)
	}
	defer endpoint.Close()
	for _, test := range []struct{ name, token, role, scope string }{
		{"wrong token", "wrong", "worker", "claim-1"},
		{"other claim", endpoint.Token, "worker", "claim-2"},
		{"other role", endpoint.Token, "leader", "claim-1"},
	} {
		t.Run(test.name, func(t *testing.T) {
			if connection, err := protocol.ConnectMCP(ctx, endpoint.Address, test.token, test.role, test.scope); err == nil {
				connection.Close()
				t.Fatal("unauthorized MCP connection accepted")
			}
		})
	}
	connection, err := protocol.ConnectMCP(ctx, endpoint.Address, endpoint.Token, "worker", "claim-1")
	if err != nil {
		t.Fatal(err)
	}
	client, err := mcp.Connect(ctx, "group", connection, connection)
	if err != nil {
		t.Fatal(err)
	}
	defer client.Close()
	operations, err := client.Tools(ctx)
	if err != nil || len(operations) != 1 || operations[0].Spec().Name != "mcp__group__submit_report" {
		t.Fatalf("tools=%v err=%v", operations, err)
	}
	endpoint.Close()
	if _, err := client.Tools(ctx); err == nil {
		t.Fatal("closed endpoint remained usable")
	}
}
