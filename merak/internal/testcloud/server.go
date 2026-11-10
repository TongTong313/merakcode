// Package testcloud provides a real device-link peer for integration tests.
package testcloud

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"sync/atomic"
	"testing"

	"github.com/TongTong313/merakcode/merak/engine/event"
	"github.com/TongTong313/merakcode/merak/engine/group"
	"github.com/TongTong313/merakcode/merak/internal/cloud"
	"github.com/TongTong313/merakcode/merak/internal/platform/websocket"
	"github.com/TongTong313/merakcode/merak/protocol"
)

type Server struct {
	Paused    atomic.Bool
	Server    *httptest.Server
	Announced chan []group.Member
	Published chan event.Event
	Requests  chan protocol.Message
	Handle    func(protocol.Message) (any, error)
	mu        sync.Mutex
	conn      *websocket.Conn
	ready     chan struct{}
	members   []group.Member
}

func New(t *testing.T) *Server {
	t.Helper()
	s := Start()
	t.Cleanup(s.Close)
	return s
}

func Start() *Server {
	s := &Server{Announced: make(chan []group.Member, 64), Published: make(chan event.Event, 4096), Requests: make(chan protocol.Message, 128), ready: make(chan struct{})}
	s.Server = httptest.NewServer(http.HandlerFunc(s.serve))
	return s
}

func (s *Server) Close() {
	s.Disconnect()
	s.Server.Close()
}
func (s *Server) Credentials() cloud.Credentials {
	return cloud.Credentials{Endpoint: strings.Replace(s.Server.URL, "http:", "ws:", 1), Token: "fixture-secret", Account: "fixture-account", Device: "fixture-device"}
}

func (s *Server) Members() []group.Member {
	s.mu.Lock()
	defer s.mu.Unlock()
	return append([]group.Member(nil), s.members...)
}

func (s *Server) Disconnect() {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.conn != nil {
		_ = s.conn.Close()
	}
}
func (s *Server) Send(ctx context.Context, in protocol.CloudInbound) error {
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-s.ready:
	}
	body, _ := json.Marshal(in)
	message, _ := json.Marshal(protocol.Message{JSONRPC: "2.0", Method: "device.inbound", Params: body})
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.conn.Write(message)
}
func (s *Server) serve(w http.ResponseWriter, r *http.Request) {
	if s.Paused.Load() {
		http.Error(w, "Offline", 503)
		return
	}
	if r.URL.Path == "/auth/dev" && r.Method == http.MethodPost {
		var request struct {
			Device string `json:"device"`
		}
		if json.NewDecoder(r.Body).Decode(&request) != nil || request.Device == "" {
			http.Error(w, "Invalid request", 400)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]string{"account": "fixture-account", "token": "fixture-secret"})
		return
	}
	if r.Header.Get("Authorization") != "Bearer fixture-secret" {
		http.Error(w, "Unauthorized", 401)
		return
	}
	conn, err := websocket.Accept(w, r)
	if err != nil {
		return
	}
	defer conn.Close()
	s.mu.Lock()
	s.conn = conn
	select {
	case <-s.ready:
	default:
		close(s.ready)
	}
	s.mu.Unlock()
	for {
		body, err := conn.Read()
		if err != nil {
			return
		}
		var request protocol.Message
		if json.Unmarshal(body, &request) != nil {
			return
		}
		var result any = struct{}{}
		var callErr error
		switch request.Method {
		case "hello":
			result = protocol.HelloResult{Protocol: protocol.Version, Engine: "fixture"}
		case "device.attach":
		case "device.announce":
			var members []group.Member
			callErr = json.Unmarshal(request.Params, &members)
			s.mu.Lock()
			s.members = members
			s.mu.Unlock()
			s.Announced <- members
		case "device.publish":
			var facts []event.Event
			callErr = json.Unmarshal(request.Params, &facts)
			for _, fact := range facts {
				s.Published <- fact
			}
		default:
			s.Requests <- request
			if s.Handle != nil {
				result, callErr = s.Handle(request)
			}
		}
		reply := protocol.Message{JSONRPC: "2.0", ID: request.ID}
		reply.Result, _ = json.Marshal(result)
		if callErr != nil {
			reply.Result = nil
			reply.Error = &protocol.Error{Code: -32000, Message: "Device request failed", Data: protocol.ErrorData{Code: callErr.Error()}}
		}
		body, _ = json.Marshal(reply)
		if conn.Write(body) != nil {
			return
		}
	}
}
