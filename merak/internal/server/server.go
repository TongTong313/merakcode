// Package server serves the engine over an authenticated local JSON-RPC connection.
package server

import (
	"bytes"
	"context"
	"crypto/subtle"
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
	"github.com/TongTong313/merakcode/merak/engine/model"
	"github.com/TongTong313/merakcode/merak/engine/permission"
	"github.com/TongTong313/merakcode/merak/engine/question"
	"github.com/TongTong313/merakcode/merak/engine/store"
	"github.com/TongTong313/merakcode/merak/engine/task"
	"github.com/TongTong313/merakcode/merak/engine/terminal"
	"github.com/TongTong313/merakcode/merak/engine/worker"
	"github.com/TongTong313/merakcode/merak/internal/platform/config"
	"github.com/TongTong313/merakcode/merak/internal/platform/websocket"
	"github.com/TongTong313/merakcode/merak/protocol"
)

type Server struct {
	questions   map[event.ID]*pendingQuestion
	settings    *config.Store
	configMu    sync.Mutex
	Level       *slog.LevelVar
	dataDir     string
	logRoot     string
	Storage     *RemoteStore
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
	return &Server{engine: e, token: token, connections: make(map[*websocket.Conn]bool), desktops: make(map[*websocket.Conn]string), approvals: make(map[event.ID]*approval), questions: make(map[event.ID]*pendingQuestion), forwarded: make(map[*websocket.Conn]chan struct{}), done: make(chan struct{})}
}

func (s *Server) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if s.token == "" || subtle.ConstantTimeCompare([]byte(r.Header.Get("Authorization")), []byte("Bearer "+s.token)) != 1 {
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
	var stopSubscription func()
	defer func() {
		// Release remote calls before waiting for the event bus subscription lock.
		cancel()
		conn.Close()
		if s.Storage != nil {
			if s.Storage.detach(conn) {
				s.engine.DisconnectedStorage()
			}
		}
		if stopSubscription != nil {
			stopSubscription()
		}
		s.mu.Lock()
		defer s.mu.Unlock()
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
			if pending.owner == conn || pending.owner == nil && !available {
				select {
				case pending.reply <- permission.Reply{Decision: permission.Deny}:
				default:
				}
			}
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
	helloResult := protocol.HelloResult{Protocol: protocol.Version, Engine: merak.Version()}
	if hello.Capabilities.Store {
		helloResult.Store = "declined"
		if s.Storage != nil && s.Storage.attach(conn) {
			helloResult.Store = "accepted"
		}
	}
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
	storageReady := make(chan struct{})
	var storageErr error
	if helloResult.Store == "accepted" {
		go func() {
			storageErr = s.engine.ReconnectStorage(ctx, s.Storage)
			close(storageReady)
		}()
	} else {
		close(storageReady)
	}
	filters := make(map[event.ID]event.Filter)
	var filterMu sync.RWMutex
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
			filterMu.RLock()
			for _, filter := range filters {
				if filter.Matches(fact) {
					matched = true
					break
				}
			}
			filterMu.RUnlock()
			if fact.Type == permission.Requested && hello.Capabilities.Approve {
				matched = s.offerApproval(conn, fact.ID)
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
		if request.JSONRPC == "2.0" && request.Method == "" && len(request.ID) > 0 && (len(request.Result) > 0 || request.Error != nil) {
			if s.Storage != nil {
				s.Storage.receive(conn, request)
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
			select {
			case <-storageReady:
			case <-ctx.Done():
				return
			}
			response := protocol.Message{JSONRPC: "2.0", ID: request.ID}
			if storageErr != nil {
				response.Error = protocol.StorageError(storageErr)
				body, _ := json.Marshal(response)
				_ = conn.Write(body)
				return
			}
			var result any = struct{}{}
			var callErr error
			switch request.Method {
			case "profile.list":
				var params protocol.ProfileListParams
				callErr = decodeParams(request.Params, &params)
				if callErr == nil {
					result, callErr = s.engine.ListProfiles(ctx, params.Human)
				}
			case "profile.save":
				var params protocol.ProfileSaveParams
				callErr = decodeParams(request.Params, &params)
				if callErr == nil {
					result, callErr = s.engine.SaveProfile(ctx, params.Human, params.Profile)
				}
			case "member.register":
				var params protocol.MemberRegisterParams
				callErr = decodeParams(request.Params, &params)
				if callErr == nil {
					result, callErr = s.engine.RegisterMember(ctx, params.Group, params.Human, params.Member)
				}
			case "member.test":
				var params protocol.ProfileSaveParams
				callErr = decodeParams(request.Params, &params)
				if callErr == nil {
					result, callErr = s.engine.TestMember(ctx, params.Human, params.Profile)
				}
			case "group.create":
				var params protocol.GroupCreateParams
				callErr = decodeParams(request.Params, &params)
				if callErr == nil {
					result, callErr = s.engine.CreateGroup(ctx, params.Group, params.Members, params.Profiles)
				}
			case "group.addMember":
				var params protocol.GroupAddMemberParams
				callErr = decodeParams(request.Params, &params)
				if callErr == nil {
					result, callErr = s.engine.AddGroupMember(ctx, params.Group, params.Member, params.Profile)
				}
			case "group.update":
				var params protocol.GroupUpdateParams
				callErr = decodeParams(request.Params, &params)
				if callErr == nil {
					result, callErr = s.engine.UpdateGroupSettings(ctx, params.Group, params.Human, params.Settings)
				}
			case "group.state":
				var params protocol.GroupIDParams
				callErr = decodeParams(request.Params, &params)
				if callErr == nil {
					result, callErr = s.engine.GroupState(ctx, params.Group)
				}
			case "group.say":
				var params protocol.GroupSayParams
				callErr = decodeParams(request.Params, &params)
				if callErr == nil {
					result, callErr = s.engine.SayGroup(ctx, params.Group, params.Task, params.Human, params.Message)
				}
			case "task.assign":
				var params protocol.TaskAssignParams
				callErr = decodeParams(request.Params, &params)
				if callErr == nil {
					result, callErr = s.engine.AssignTask(ctx, params.Task, params.Human, params.Member, params.Role, params.Scope)
				}
			case "task.review":
				var params protocol.TaskReviewParams
				callErr = decodeParams(request.Params, &params)
				if callErr == nil {
					callErr = s.engine.ReviewTask(ctx, params.Task, params.Human, params.Decision, params.Feedback)
				}
			case "task.update":
				var params protocol.TaskUpdateParams
				callErr = decodeParams(request.Params, &params)
				if callErr == nil {
					callErr = s.engine.Tasks.Update(ctx, params.Task, params.Update, event.Actor{Kind: event.ActorHuman, ID: params.Human})
				}
				if callErr == nil {
					result, callErr = s.engine.Tasks.Get(ctx, params.Task)
				}
			case "task.cancel":
				var params protocol.TaskCancelParams
				callErr = decodeParams(request.Params, &params)
				if callErr == nil {
					callErr = s.engine.Tasks.SetPhase(ctx, params.Task, task.PhaseCancelled, event.Actor{Kind: event.ActorHuman, ID: params.Human})
				}
				if callErr == nil {
					result, callErr = s.engine.Tasks.Get(ctx, params.Task)
				}
			case "task.create":
				var params protocol.TaskCreateParams
				callErr = decodeParams(request.Params, &params)
				if callErr == nil {
					card := task.Card{Group: params.Group, Leader: params.Leader, Title: params.Title, Description: params.Description, Acceptance: params.Acceptance, Areas: params.Areas, Review: params.Review, Priority: params.Priority, Workspace: params.Workspace, Inputs: params.Inputs, CreatedBy: event.Actor{Kind: event.ActorHuman, ID: params.Human}}
					if params.Member != "" {
						result, callErr = s.engine.CreateAssignedTask(ctx, card, params.Member)
					} else {
						result, callErr = s.engine.CreateTask(ctx, card)
					}
				}
			case "config.get":
				callErr = decodeParams(request.Params, &struct{}{})
				if callErr == nil {
					result = s.configuration()
				}
			case "config.set":
				var patch config.Patch
				callErr = decodeParams(request.Params, &patch)
				if callErr == nil {
					result, callErr = s.configure(patch)
				}
			case "member.catalog":
				callErr = decodeParams(request.Params, &struct{}{})
				if callErr == nil {
					result = worker.Catalog(ctx)
				}
			case "model.list":
				callErr = decodeParams(request.Params, &struct{}{})
				if callErr == nil {
					result = s.engine.ModelCatalog()
				}
			case "model.discover":
				var params protocol.ModelDiscoverParams
				callErr = decodeParams(request.Params, &params)
				if callErr == nil {
					result, callErr = discoverModels(ctx, params.Provider)
				}
			case "model.refresh":
				var params protocol.ModelRefreshParams
				callErr = decodeParams(request.Params, &params)
				if callErr == nil {
					callErr = s.engine.RefreshModels(ctx, params.Provider)
				}
				if callErr == nil {
					result = s.engine.ModelCatalog()
				}
			case "diagnostics.bundle":
				var params protocol.DiagnosticsParams
				callErr = decodeParams(request.Params, &params)
				if callErr == nil {
					result, callErr = s.diagnostics(ctx, params)
				}
			case "blob.read":
				var params protocol.BlobReadParams
				callErr = decodeParams(request.Params, &params)
				if callErr == nil {
					var data []byte
					var total int
					data, total, callErr = s.engine.ReadBlob(ctx, params.Ref, params.Offset, params.Limit)
					result = protocol.BlobReadResult{Data: data, Total: total, Offset: params.Offset}
				}
			case "engine.stop":
				callErr = decodeParams(request.Params, &struct{}{})
			case "session.list":
				callErr = decodeParams(request.Params, &struct{}{})
				if callErr == nil {
					result, callErr = s.engine.ListSessions(ctx)
				}
			case "session.snapshot":
				var params protocol.SessionCancelParams
				callErr = decodeParams(request.Params, &params)
				if callErr == nil {
					result, callErr = s.engine.SessionSnapshot(ctx, params.Session)
				}
			case "events.read":
				var p protocol.EventsReadParams
				callErr = decodeParams(request.Params, &p)
				if callErr == nil {
					result, callErr = s.engine.ReadEvents(ctx, p.Stream, p.From, p.Limit)
				}
			case "event.emit":
				var params protocol.EventEmitParams
				callErr = decodeParams(request.Params, &params)
				if callErr == nil {
					result, callErr = s.engine.EmitEvent(ctx, params.Group, params.Type, params.Payload)
				}
			case "events.find":
				var p store.Query
				callErr = decodeParams(request.Params, &p)
				if callErr == nil {
					result, callErr = s.engine.FindEvents(ctx, p)
				}
			case "events.get":
				var p protocol.EventsGetParams
				callErr = decodeParams(request.Params, &p)
				if callErr == nil {
					result, callErr = s.engine.GetEvent(ctx, p.ID)
				}
			case "terminal.list":
				var params protocol.DirectoryParams
				callErr = decodeParams(request.Params, &params)
				if callErr == nil {
					result = s.engine.Terminals.List(params.Directory)
				}
			case "terminal.create":
				var params terminal.CreateOptions
				callErr = decodeParams(request.Params, &params)
				if callErr == nil {
					result, callErr = s.engine.Terminals.Create(ctx, params)
				}
			case "terminal.get", "terminal.remove":
				var params protocol.TerminalIDParams
				callErr = decodeParams(request.Params, &params)
				if callErr == nil {
					if request.Method == "terminal.get" {
						result, callErr = s.engine.Terminals.Get(params.ID)
					} else {
						callErr = s.engine.Terminals.Remove(ctx, params.ID)
					}
				}
			case "terminal.update":
				var params protocol.TerminalUpdateParams
				callErr = decodeParams(request.Params, &params)
				if callErr == nil {
					result, callErr = s.engine.Terminals.Update(ctx, params.ID, params.UpdateOptions)
				}
			case "file.read", "file.list":
				var params protocol.FileParams
				callErr = decodeParams(request.Params, &params)
				if callErr == nil {
					if request.Method == "file.read" {
						result, callErr = s.engine.ReadFile(ctx, params.Directory, params.Path)
					} else {
						result, callErr = s.engine.ListFiles(ctx, params.Directory, params.Path)
					}
				}
			case "repo.status", "repo.branches":
				var params protocol.DirectoryParams
				callErr = decodeParams(request.Params, &params)
				if callErr == nil {
					if request.Method == "repo.status" {
						result, callErr = s.engine.RepoStatus(ctx, params.Directory)
					} else {
						result, callErr = s.engine.RepoBranches(ctx, params.Directory)
					}
				}
			case "repo.diff":
				var params protocol.RepoDiffParams
				callErr = decodeParams(request.Params, &params)
				if callErr == nil {
					result, callErr = s.engine.RepoDiff(ctx, params.Directory, params.Base, params.Session)
				}
			case "repo.checkout":
				var params protocol.RepoCheckoutParams
				callErr = decodeParams(request.Params, &params)
				if callErr == nil {
					callErr = s.engine.RepoCheckout(ctx, params.Directory, params.Branch)
				}
			case "session.create":
				var params protocol.SessionCreateParams
				callErr = decodeParams(request.Params, &params)
				if callErr == nil {
					settings := s.configuration()
					if params.Provider == "" {
						params.Provider, params.Model, _ = strings.Cut(settings.Model, "/")
					}
					if params.Thinking == "" {
						params.Thinking = model.Thinking(settings.Thinking)
					}
					var id event.ID
					id, callErr = s.engine.CreateSession(ctx, engine.SessionOptions{Provider: params.Provider, Model: params.Model, Thinking: params.Thinking, Workdir: params.Workdir})
					result = protocol.SessionCreateResult{Session: id}
				}
			case "session.send":
				var params protocol.SessionSendParams
				callErr = decodeParams(request.Params, &params)
				if callErr == nil {
					if params.Selection != nil {
						callErr = s.engine.Send(ctx, params.Session, params.Parts, *params.Selection)
					} else {
						callErr = s.engine.Send(ctx, params.Session, params.Parts)
					}
				}
			case "session.cancel":
				var params protocol.SessionCancelParams
				callErr = decodeParams(request.Params, &params)
				if callErr == nil {
					callErr = s.engine.Cancel(params.Session)
				}
			case "permission.reply":
				var params protocol.PermissionReplyParams
				callErr = decodeParams(request.Params, &params)
				if callErr == nil {
					callErr = s.replyApproval(ctx, conn, params)
				}
			case "question.reply":
				var params protocol.QuestionReplyParams
				callErr = decodeParams(request.Params, &params)
				if callErr == nil {
					callErr = s.replyQuestion(ctx, conn, params)
				}
			case "events.subscribe":
				var filter event.Filter
				callErr = decodeParams(request.Params, &filter)
				if callErr == nil {
					id := event.NewID()
					filterMu.Lock()
					filters[id] = filter
					filterMu.Unlock()
					result = protocol.SubscribeResult{Subscription: id}
				}
			case "events.unsubscribe":
				var params protocol.UnsubscribeParams
				callErr = decodeParams(request.Params, &params)
				if callErr == nil {
					filterMu.Lock()
					delete(filters, params.Subscription)
					filterMu.Unlock()
				}
			default:
				response.Error = &protocol.Error{Code: -32601, Message: "Method not found", Data: protocol.ErrorData{Code: "MRK-1001"}}
			}
			if callErr != nil {
				code := "MRK-4001"
				if strings.HasPrefix(request.Method, "group.") || strings.HasPrefix(request.Method, "task.") || request.Method == "event.emit" {
					code = "MRK-6001"
				}
				if request.Method == "permission.reply" || request.Method == "question.reply" {
					code = "MRK-5002"
				}
				if request.Method == "diagnostics.bundle" {
					code = "MRK-1004"
				}
				if strings.HasPrefix(request.Method, "file.") || strings.HasPrefix(request.Method, "terminal.") || strings.HasPrefix(request.Method, "repo.") {
					code = "MRK-5001"
				}
				if request.Method == "blob.read" {
					code = "MRK-1003"
				}
				if strings.HasPrefix(request.Method, "config.") {
					code = "MRK-3001"
				}
				response.Error = &protocol.Error{Code: -32602, Message: "Invalid request parameters", Data: protocol.ErrorData{Code: code}}
				if errors.Is(callErr, store.ErrUnavailable) {
					response.Error = protocol.StorageError(callErr)
				}
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
