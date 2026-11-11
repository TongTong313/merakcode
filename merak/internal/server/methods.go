package server

import (
	"context"
	"encoding/json"
	"errors"
	"maps"
	"slices"
	"sync"

	"github.com/TongTong313/merakcode/merak/engine/event"
	"github.com/TongTong313/merakcode/merak/internal/platform/websocket"
)

// connection is what a method needs to know about the connection that called it.
type connection struct {
	ws     *websocket.Conn
	human  event.ID
	remote *remoteSession
	// filters are the event subscriptions of the connection; the goroutine that forwards events reads them.
	filterMu sync.RWMutex
	filters  map[event.ID]event.Filter
}

// handler serves one method of the protocol. Its result is encoded as the result of the call; a nil result is an empty
// object.
type handler func(ctx context.Context, c *connection, params json.RawMessage) (any, error)

var errMethodNotFound = errors.New("method not found")

// methods is the table of the protocol methods this server serves, one handler for each, joined from the files of
// the domains.
func (s *Server) methods() map[string]handler {
	table := map[string]handler{}
	for _, part := range []map[string]handler{
		s.sessionMethods(), s.groupMethods(), s.taskMethods(), s.fileMethods(), s.configMethods(), s.eventMethods(), s.cloudMethods(),
	} {
		maps.Copy(table, part)
	}
	return table
}

// HandledMethods lists the methods the server serves, sorted.
func HandledMethods() []string {
	return slices.Sorted(maps.Keys((&Server{}).methods()))
}

// decode reads the parameters of a call: an object without unknown or trailing fields.
func decode[T any](raw json.RawMessage) (T, error) {
	var params T
	err := decodeParams(raw, &params)
	return params, err
}

// run turns a function of decoded parameters into a handler.
func run[P any](call func(ctx context.Context, c *connection, params P) (any, error)) handler {
	return func(ctx context.Context, c *connection, raw json.RawMessage) (any, error) {
		params, err := decode[P](raw)
		if err != nil {
			return nil, err
		}
		return call(ctx, c, params)
	}
}

// done is the result of a call that returns nothing.
func done(err error) (any, error) { return nil, err }
