package protocol

import (
	"context"
	"encoding/json"
	"errors"
	"github.com/TongTong313/merakcode/merak/engine/event"
	"strconv"
	"sync"

	"github.com/TongTong313/merakcode/merak/internal/platform/websocket"
)

type Client struct {
	ordered       bool
	Notifications chan Message
	Hello         HelloResult
	conn          *websocket.Conn
	Events        chan event.Event
	mu            sync.Mutex
	next          uint64
	pending       map[string]chan Message
	done          chan struct{}
	failure       error
	ctx           context.Context
	cancel        context.CancelFunc
}

func Connect(ctx context.Context, endpoint, token string, hello HelloParams) (*Client, error) {
	return connect(ctx, endpoint, token, hello, false)
}

// ConnectOrdered delivers every notification through Notifications in wire order.
// Events remains empty; responses keep their normal behavior.
func ConnectOrdered(ctx context.Context, endpoint, token string, hello HelloParams) (*Client, error) {
	return connect(ctx, endpoint, token, hello, true)
}

func connect(ctx context.Context, endpoint, token string, hello HelloParams, ordered bool) (*Client, error) {
	conn, err := websocket.Dial(ctx, endpoint, token)
	if err != nil {
		return nil, &Error{Code: -32000, Message: "Connection failed", Data: ErrorData{Code: "MRK-1001"}}
	}
	stop := context.AfterFunc(ctx, func() { conn.Close() })
	defer stop()
	params, err := json.Marshal(hello)
	if err != nil {
		conn.Close()
		return nil, err
	}
	body, err := json.Marshal(Message{JSONRPC: "2.0", ID: json.RawMessage("1"), Method: "hello", Params: params})
	if err != nil {
		conn.Close()
		return nil, err
	}
	if err = conn.Write(body); err != nil {
		conn.Close()
		return nil, err
	}
	body, err = conn.Read()
	if err != nil {
		conn.Close()
		return nil, err
	}
	var reply Message
	if err = json.Unmarshal(body, &reply); err != nil {
		conn.Close()
		return nil, err
	}
	if reply.Error != nil {
		conn.Close()
		return nil, reply.Error
	}
	c := &Client{ordered: ordered, conn: conn, Events: make(chan event.Event, 1024), Notifications: make(chan Message, 1024), pending: make(map[string]chan Message), done: make(chan struct{}), next: 1}
	c.ctx, c.cancel = context.WithCancel(context.Background())
	if err = json.Unmarshal(reply.Result, &c.Hello); err != nil {
		conn.Close()
		c.cancel()
		return nil, err
	}
	if c.Hello.Protocol != Version {
		conn.Close()
		c.cancel()
		return nil, &Error{Code: -32000, Message: "Protocol version is unsupported", Data: ErrorData{Code: "MRK-1001"}}
	}
	go c.read()
	return c, nil
}

func (c *Client) Close() error { err := c.conn.Close(); <-c.done; return err }

func (c *Client) Call(ctx context.Context, method string, params, result any) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	body, err := json.Marshal(params)
	if err != nil {
		return err
	}
	c.mu.Lock()
	if c.failure != nil {
		err := c.failure
		c.mu.Unlock()
		return err
	}
	c.next++
	id := strconv.FormatUint(c.next, 10)
	replies := make(chan Message, 1)
	c.pending[id] = replies
	c.mu.Unlock()
	defer func() { c.mu.Lock(); delete(c.pending, id); c.mu.Unlock() }()
	request, err := json.Marshal(Message{JSONRPC: "2.0", ID: json.RawMessage(id), Method: method, Params: body})
	if err != nil {
		return err
	}
	if err = c.conn.Write(request); err != nil {
		return err
	}
	select {
	case reply := <-replies:
		if reply.Error != nil {
			return reply.Error
		}
		if result != nil {
			return json.Unmarshal(reply.Result, result)
		}
		return nil
	case <-ctx.Done():
		return ctx.Err()
	case <-c.done:
		c.mu.Lock()
		defer c.mu.Unlock()
		return c.failure
	}
}

func (c *Client) read() {
	var failure error
	defer func() {
		c.cancel()
		c.conn.Close()
		c.mu.Lock()
		c.failure = failure
		c.mu.Unlock()
		close(c.Events)
		close(c.Notifications)
		close(c.done)
	}()
	for {
		body, err := c.conn.Read()
		if err != nil {
			failure = err
			return
		}
		var message Message
		if err = json.Unmarshal(body, &message); err != nil {
			failure = err
			return
		}
		if !c.ordered && (message.Method == "event" || message.Method == "events.lagged") {
			var fact event.Event
			if err = json.Unmarshal(message.Params, &fact); err != nil {
				failure = err
				return
			}
			select {
			case c.Events <- fact:
			default:
				failure = errors.New("MRK-1001")
				return
			}
			continue
		}
		if message.Method != "" {
			select {
			case c.Notifications <- message:
			default:
				failure = errors.New("MRK-1001")
				return
			}
			continue
		}
		c.mu.Lock()
		reply := c.pending[string(message.ID)]
		c.mu.Unlock()
		if reply != nil {
			select {
			case reply <- message:
			default:
			}
		}
	}
}
