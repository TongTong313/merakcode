package server

import (
	"context"
	"encoding/json"
	"net/http"
	"strconv"
	"strings"

	"github.com/TongTong313/merakcode/merak/engine/event"
	"github.com/TongTong313/merakcode/merak/internal/platform/websocket"
)

func (s *Server) serveTerminal(conn *websocket.Conn, request *http.Request) {
	id := event.ID(strings.TrimPrefix(request.URL.Path, "/terminal/"))
	cursor, err := strconv.ParseUint(request.URL.Query().Get("cursor"), 10, 64)
	if err != nil {
		return
	}
	subscriber, err := s.engine.Terminals.Subscribe(id, cursor)
	if err != nil {
		return
	}
	defer subscriber.Close()
	ctx, cancel := context.WithCancel(request.Context())
	defer cancel()
	done := make(chan struct{})
	go func() {
		defer close(done)
		defer conn.Close()
		for {
			chunk, err := subscriber.Next(ctx)
			if err != nil {
				return
			}
			if len(chunk.Data) > 0 {
				if err := conn.WriteBinary(chunk.Data); err != nil {
					return
				}
			}
			control, _ := json.Marshal(struct {
				Cursor uint64 `json:"cursor"`
			}{chunk.Cursor})
			if err := conn.Write(control); err != nil {
				return
			}
		}
	}()
	for {
		body, err := conn.Read()
		if err != nil {
			break
		}
		if err := s.engine.Terminals.Write(id, body); err != nil {
			break
		}
	}
	cancel()
	<-done
}
