package cloudlink

import (
	"context"

	"github.com/TongTong313/merakcode/merak/engine/collab/wire"
	"github.com/TongTong313/merakcode/merak/engine/infra/event"
	"github.com/TongTong313/merakcode/merak/protocol"
)

// Dial connects to another engine and completes its protocol handshake.
func Dial(ctx context.Context, endpoint, token, client string) (wire.Conn, error) {
	hello := protocol.HelloParams{Protocol: protocol.Version}
	if client != "" {
		hello.Client = protocol.ClientInfo{Name: client}
	}
	connected, err := protocol.Connect(ctx, endpoint, token, hello)
	if err != nil {
		return nil, err
	}
	return &protocolConn{Client: connected}, nil
}

type protocolConn struct {
	*protocol.Client
}

func (c *protocolConn) Events() <-chan event.Event { return c.Client.Events }
