// Package server serves the engine over an authenticated local JSON-RPC connection.
package server

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"

	"github.com/TongTong313/merakcode/merak"
	"github.com/TongTong313/merakcode/merak/engine"
	"github.com/TongTong313/merakcode/merak/engine/event"
	"github.com/TongTong313/merakcode/merak/engine/permission"
	"github.com/TongTong313/merakcode/merak/engine/question"
	"github.com/TongTong313/merakcode/merak/internal/migrate"
	"github.com/TongTong313/merakcode/merak/internal/platform/config"
	"github.com/TongTong313/merakcode/merak/internal/platform/websocket"
	"github.com/TongTong313/merakcode/merak/protocol"
)

type Server struct {
	cloudMu    sync.Mutex
	questions  map[event.ID]*pendingQuestion
	settings   *config.Store
	configMu   sync.Mutex
	Level      *slog.LevelVar
	dataDir    string
	configRoot string
	// migration imports the data of v0.3 that this machine may hold; it is made when the server starts.
	migration *migrate.Migration
	// human is the person the connections that carry the token act as; identities lists other tokens and their people.
	human       event.ID
	identities  map[string]event.ID
	logRoot     string
	engine      *engine.Engine
	token       string
	mu          sync.Mutex
	connections map[*websocket.Conn]bool
	desktops    map[*websocket.Conn]string
	approvals   map[event.ID]*approval
	closed      bool
	forwarded   map[*websocket.Conn]chan struct{}
	closeOnce   sync.Once
	done        chan struct{}
	closeErr    error
}

func New(e *engine.Engine, token string) *Server {
	e.SetLocalHuman(protocol.LocalHuman)
	return &Server{engine: e, migration: migrate.New(migrate.Options{Human: protocol.LocalHuman, Engine: e}), human: protocol.LocalHuman, token: token, identities: map[string]event.ID{}, connections: make(map[*websocket.Conn]bool), desktops: make(map[*websocket.Conn]string), approvals: make(map[event.ID]*approval), questions: make(map[event.ID]*pendingQuestion), forwarded: make(map[*websocket.Conn]chan struct{}), done: make(chan struct{})}
}

func (s *Server) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	human, ok := s.authenticate(r.Header.Get("Authorization"))
	if !ok {
		http.Error(w, "Unauthorized", http.StatusUnauthorized)
		return
	}
	if origin := r.Header.Get("Origin"); origin != "" {
		u, err := url.Parse(origin)
		if err != nil || u.Scheme != "http" || u.Host != r.Host || u.User != nil || u.Path != "" || u.RawQuery != "" || u.Fragment != "" {
			http.Error(w, "Forbidden", http.StatusForbidden)
			return
		}
	}
	conn, err := websocket.Accept(w, r)
	if err != nil {
		return
	}
	s.mu.Lock()
	if s.closed {
		s.mu.Unlock()
		conn.Close()
		return
	}
	s.connections[conn] = false
	s.mu.Unlock()
	ctx, cancel := context.WithCancel(context.Background())
	remote := newRemoteSession(ctx, s.engine)
	var stopSubscription func()
	defer func() {
		// Release remote calls before waiting for the event bus subscription lock.
		cancel()
		conn.Close()
		s.engine.DropClientTools((&connection{ws: conn}).owner())
		s.engine.UnwatchDirectories((&connection{ws: conn}).owner())
		remote.close()
		if stopSubscription != nil {
			stopSubscription()
		}
		s.mu.Lock()
		delete(s.connections, conn)
		delete(s.desktops, conn)
		delete(s.forwarded, conn)
		available := false
		for _, approve := range s.connections {
			available = available || approve
		}
		for _, pending := range s.questions {
			if pending.owner == conn || pending.owner == nil && !available {
				select {
				case pending.reply <- question.Answer{Cancelled: true}:
				default:
				}
			}
		}
		for _, pending := range s.approvals {
			if pending.group {
				if pending.owner == conn {
					pending.owner = nil
				}
				continue
			}
			if pending.owner == conn || pending.owner == nil && !available {
				select {
				case pending.reply <- permission.Reply{Decision: permission.Deny}:
				default:
				}
			}
		}
		var remaining []*websocket.Conn
		for connected, approve := range s.connections {
			if approve {
				remaining = append(remaining, connected)
			}
		}
		s.mu.Unlock()
		for _, connected := range remaining {
			go func() {
				ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
				defer cancel()
				_ = s.offerPendingApprovals(ctx, connected)
			}()
		}
	}()
	if strings.HasPrefix(r.URL.Path, "/terminal/") {
		s.serveTerminal(conn, r)
		return
	}
	body, err := conn.Read()
	if err != nil {
		return
	}
	var request protocol.Message
	if json.Unmarshal(body, &request) != nil {
		return
	}
	var hello protocol.HelloParams
	response := protocol.Message{JSONRPC: "2.0", ID: request.ID}
	if request.JSONRPC != "2.0" || request.Method != "hello" || decodeParams(request.Params, &hello) != nil || hello.Protocol != protocol.Version {
		response.Error = &protocol.Error{Code: -32001, Message: "Protocol mismatch", Data: protocol.ErrorData{Code: "MRK-1002"}}
		body, _ = json.Marshal(response)
		_ = conn.Write(body)
		return
	}
	helloResult := protocol.HelloResult{Human: human, Protocol: protocol.Version, Engine: merak.Version()}
	response.Result, _ = json.Marshal(helloResult)
	s.mu.Lock()
	s.connections[conn] = hello.Capabilities.Approve
	if hello.Client.Name == "desktop" {
		s.desktops[conn] = hello.Client.Version
	}
	s.mu.Unlock()
	body, _ = json.Marshal(response)
	if conn.Write(body) != nil {
		return
	}
	c := &connection{ws: conn, human: human, remote: remote, closed: ctx.Done(), filters: make(map[event.ID]event.Filter)}
	table := s.methods()
	events, stop := s.engine.Bus.Subscribe(event.Filter{})
	stopSubscription = stop
	forwarded := make(chan struct{})
	s.mu.Lock()
	s.forwarded[conn] = forwarded
	s.mu.Unlock()
	go func() {
		defer close(forwarded)
		for fact := range events {
			matched := fact.Type == event.Lagged || fact.Type == engine.Shutdown
			c.filterMu.RLock()
			for _, filter := range c.filters {
				if filter.Matches(fact) {
					matched = true
					break
				}
			}
			c.filterMu.RUnlock()
			if fact.Type == permission.Requested && hello.Capabilities.Approve {
				request, err := event.Decode[permission.Request](fact)
				matched = err == nil && request.Leader == "" && s.offerApproval(conn, fact.ID, fact.Scope.Group != "" || request.Kind == "workspace")
			}
			if fact.Type == permission.Escalated && hello.Capabilities.Approve {
				matched = s.offerApproval(conn, fact.Cause, fact.Scope.Group != "")
			}
			if fact.Type == question.Asked && hello.Capabilities.Approve {
				matched = s.offerQuestion(conn, fact.ID)
			}
			if !matched {
				continue
			}
			payload, _ := json.Marshal(fact)
			method := "event"
			if fact.Type == event.Lagged {
				method = "events.lagged"
			}
			body, _ := json.Marshal(protocol.Message{JSONRPC: "2.0", Method: method, Params: payload})
			if conn.Write(body) != nil {
				return
			}
			if fact.Type == engine.Shutdown {
				return
			}
		}
	}()
	if hello.Capabilities.Approve {
		go func() {
			if err := s.offerPendingApprovals(ctx, conn); err != nil {
				_ = conn.Close()
			}
		}()
	}
	for {
		body, err := conn.Read()
		if err != nil {
			return
		}
		var request protocol.Message
		if json.Unmarshal(body, &request) != nil {
			if replyRPCError(conn, nil, -32700, "Parse error") != nil {
				return
			}
			continue
		}
		if request.JSONRPC != "2.0" || request.Method == "" || !validID(request.ID) || len(request.Result) != 0 || request.Error != nil {
			if replyRPCError(conn, request.ID, -32600, "Invalid request") != nil {
				return
			}
			continue
		}
		go func(request protocol.Message) {
			response := protocol.Message{JSONRPC: "2.0", ID: request.ID}
			var result any = struct{}{}
			var callErr error
			if forwarded, handled, err := s.engine.ForwardCloud(ctx, request.Method, request.Params); handled {
				result, callErr = forwarded, err
			} else if call := table[request.Method]; call == nil {
				callErr = errMethodNotFound
			} else if value, err := call(ctx, c, request.Params); err != nil {
				callErr = err
			} else if value != nil {
				result = value
			}
			if callErr != nil {
				response.Error = rpcError(request.Method, callErr)
			}
			if len(request.ID) == 0 {
				return
			}
			if response.Error == nil {
				response.Result, _ = json.Marshal(result)
			}
			body, _ := json.Marshal(response)
			if conn.Write(body) != nil {
				conn.Close()
				return
			}
			if request.Method == "engine.stop" && callErr == nil {
				go s.Close()
			}
		}(request)
	}
}

func validID(id json.RawMessage) bool {
	if len(id) == 0 {
		return true
	}
	return id[0] == '"' || id[0] == '-' || id[0] >= '0' && id[0] <= '9' || string(id) == "null"
}

func replyRPCError(conn *websocket.Conn, id json.RawMessage, code int, message string) error {
	if len(id) == 0 || !validID(id) {
		id = json.RawMessage("null")
	}
	body, err := json.Marshal(protocol.Message{JSONRPC: "2.0", ID: id, Error: &protocol.Error{Code: code, Message: message, Data: protocol.ErrorData{Code: "MRK-1001"}}})
	if err != nil {
		return err
	}
	return conn.Write(body)
}

func decodeParams(body []byte, target any) error {
	if len(body) == 0 {
		body = []byte(`{}`)
	}
	body = bytes.TrimSpace(body)
	if len(body) == 0 || body[0] != '{' {
		return errors.New("invalid parameters")
	}
	decoder := json.NewDecoder(bytes.NewReader(body))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(target); err != nil {
		return err
	}
	if err := decoder.Decode(new(any)); err != io.EOF {
		return errors.New("trailing parameters")
	}
	return nil
}

func (s *Server) Close() error {
	s.closeOnce.Do(func() {
		defer close(s.done)
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		s.mu.Lock()
		s.closed = true
		s.mu.Unlock()
		s.migration.Close()
		s.closeErr = s.engine.Shutdown(ctx)
		s.mu.Lock()
		var forwarded []chan struct{}
		for _, done := range s.forwarded {
			forwarded = append(forwarded, done)
		}
		s.mu.Unlock()
		if s.closeErr == nil {
			for _, done := range forwarded {
				select {
				case <-done:
				case <-ctx.Done():
				}
			}
		}
		s.mu.Lock()
		for conn := range s.connections {
			conn.Close()
		}
		s.mu.Unlock()
	})
	return s.closeErr
}

func (s *Server) Done() <-chan struct{} { return s.done }
