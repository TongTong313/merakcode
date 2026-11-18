package wire

import (
	"context"

	"github.com/TongTong313/merakcode/merak/engine/infra/event"
)

// Conn is a connection to another engine.
type Conn interface {
	Call(ctx context.Context, method string, params, result any) error
	Events() <-chan event.Event
	Close() error
}

// Dial connects to the engine at endpoint and performs the protocol handshake. Client names the caller in the
// handshake; an empty name sends none.
type Dial func(ctx context.Context, endpoint, token, client string) (Conn, error)
