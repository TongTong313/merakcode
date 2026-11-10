package server

import (
	"context"
	"encoding/json"
	"errors"
	"strconv"
	"sync"
	"time"

	"github.com/TongTong313/merakcode/merak/engine/event"
	"github.com/TongTong313/merakcode/merak/engine/store"
	"github.com/TongTong313/merakcode/merak/internal/platform/websocket"
	"github.com/TongTong313/merakcode/merak/protocol"
)

// RemoteStore forwards persistence requests to the single accepted host.
type RemoteStore struct {
	onTimeout func()
	mu        sync.Mutex
	conn      *websocket.Conn
	next      uint64
	pending   map[string]chan protocol.Message
}

func NewRemoteStore() *RemoteStore {
	return &RemoteStore{pending: make(map[string]chan protocol.Message)}
}

func (s *RemoteStore) attach(conn *websocket.Conn, onTimeout func()) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.conn != nil {
		return false
	}
	s.conn = conn
	s.onTimeout = onTimeout
	return true
}

func (s *RemoteStore) detach(conn *websocket.Conn) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.conn != conn {
		return false
	}
	s.conn = nil
	for id, reply := range s.pending {
		select {
		case reply <- protocol.Message{Error: protocol.StorageError(store.ErrUnavailable)}:
		default:
		}
		delete(s.pending, id)
	}
	return true
}

func (s *RemoteStore) receive(conn *websocket.Conn, response protocol.Message) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.conn != conn {
		return
	}
	if reply := s.pending[string(response.ID)]; reply != nil {
		select {
		case reply <- response:
		default:
		}
	}
}

func (s *RemoteStore) call(ctx context.Context, method string, params, result any) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	s.mu.Lock()
	conn := s.conn
	onTimeout := s.onTimeout
	if conn == nil {
		s.mu.Unlock()
		return store.ErrUnavailable
	}
	s.next++
	id, _ := json.Marshal("store:" + strconv.FormatUint(s.next, 10))
	reply := make(chan protocol.Message, 1)
	s.pending[string(id)] = reply
	s.mu.Unlock()
	ctx, cancel := context.WithTimeoutCause(ctx, 30*time.Second, errStorageTimeout)
	defer cancel()
	expire := func() {
		if !errors.Is(context.Cause(ctx), errStorageTimeout) {
			return
		}
		if s.detach(conn) {
			_ = conn.Close()
			if onTimeout != nil {
				go onTimeout()
			}
		}
	}
	stop := context.AfterFunc(ctx, expire)
	defer stop()
	defer func() { s.mu.Lock(); delete(s.pending, string(id)); s.mu.Unlock() }()
	body, err := json.Marshal(params)
	if err != nil {
		return err
	}
	request, err := json.Marshal(protocol.Message{JSONRPC: "2.0", ID: id, Method: method, Params: body})
	if err != nil {
		return err
	}
	if err := conn.Write(request); err != nil {
		return store.ErrUnavailable
	}
	select {
	case response := <-reply:
		if response.Error != nil {
			return response.Error
		}
		if result != nil {
			return json.Unmarshal(response.Result, result)
		}
		return nil
	case <-ctx.Done():
		if errors.Is(context.Cause(ctx), errStorageTimeout) {
			expire()
			return store.ErrUnavailable
		}
		return ctx.Err()
	}
}

var errStorageTimeout = errors.New("storage acknowledgement timed out")

func (s *RemoteStore) Append(ctx context.Context, events []event.Event) error {
	return s.call(ctx, "store.append", protocol.StoreAppendParams{Events: events}, nil)
}
func (s *RemoteStore) Read(ctx context.Context, stream event.Stream, from uint64, limit int) ([]event.Event, error) {
	var result []event.Event
	err := s.call(ctx, "store.read", protocol.EventsReadParams{Stream: stream, From: from, Limit: limit}, &result)
	return result, err
}
func (s *RemoteStore) Find(ctx context.Context, q store.Query) ([]event.Event, error) {
	var result []event.Event
	err := s.call(ctx, "store.find", q, &result)
	return result, err
}
func (s *RemoteStore) Get(ctx context.Context, id event.ID) (event.Event, error) {
	var result event.Event
	err := s.call(ctx, "store.get", protocol.EventsGetParams{ID: id}, &result)
	return result, err
}
func (s *RemoteStore) Put(ctx context.Context, doc store.Doc) error {
	return s.call(ctx, "store.put", protocol.StorePutParams{Doc: doc}, nil)
}
func (s *RemoteStore) Fetch(ctx context.Context, kind, key string) (store.Doc, error) {
	var result store.Doc
	err := s.call(ctx, "store.fetch", protocol.StoreFetchParams{Kind: kind, Key: key}, &result)
	return result, err
}
func (s *RemoteStore) List(ctx context.Context, kind, prefix string) ([]store.DocMeta, error) {
	var result []store.DocMeta
	err := s.call(ctx, "store.list", protocol.StoreListParams{Kind: kind, Prefix: prefix}, &result)
	return result, err
}
