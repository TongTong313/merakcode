package cloud

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"net"
	"net/url"
	"sync"
	"time"

	"github.com/TongTong313/merakcode/merak"
	"github.com/TongTong313/merakcode/merak/engine/event"
	"github.com/TongTong313/merakcode/merak/engine/group"
	"github.com/TongTong313/merakcode/merak/protocol"
)

type WebSocket struct {
	announceMu   sync.Mutex
	announced    string
	announcedTo  *protocol.Client
	mu           sync.Mutex
	client       *protocol.Client
	ready        chan struct{}
	inbound      chan Inbound
	members      []group.Member
	membersKnown bool
	connecting   bool
}

func NewWebSocket() *WebSocket {
	return &WebSocket{ready: make(chan struct{}), inbound: make(chan Inbound, 64)}
}

func ValidEndpoint(endpoint string) bool {
	parsed, err := url.Parse(endpoint)
	if err != nil || parsed.Host == "" || parsed.User != nil || parsed.Fragment != "" || parsed.RawQuery != "" {
		return false
	}
	if parsed.Scheme == "wss" {
		return true
	}
	return parsed.Scheme == "ws" && (parsed.Hostname() == "localhost" || net.ParseIP(parsed.Hostname()).IsLoopback())
}

func (w *WebSocket) Connect(ctx context.Context, creds Credentials) error {
	if !ValidEndpoint(creds.Endpoint) || creds.Token == "" || creds.Account == "" || creds.Device == "" {
		return errors.New("MRK-3001")
	}
	w.mu.Lock()
	if w.connecting {
		w.mu.Unlock()
		return errors.New("device link is already running")
	}
	w.connecting = true
	w.mu.Unlock()
	defer func() { w.mu.Lock(); w.connecting = false; w.mu.Unlock() }()
	backoff := 100 * time.Millisecond
	for ctx.Err() == nil {
		handshake, stop := context.WithTimeout(ctx, 10*time.Second)
		client, err := protocol.ConnectOrdered(handshake, creds.Endpoint, creds.Token, protocol.HelloParams{Protocol: protocol.Version, Client: protocol.ClientInfo{Name: "merak-device", Version: merak.Version()}})
		if err == nil {
			err = client.Call(handshake, "device.attach", struct {
				Account string `json:"account"`
				Device  string `json:"device"`
			}{creds.Account, creds.Device}, nil)
		}
		stop()
		if err == nil {
			backoff = 100 * time.Millisecond
			w.mu.Lock()
			known := w.membersKnown
			w.client = client
			close(w.ready)
			w.mu.Unlock()
			if known {
				err = w.announce(ctx, client)
			}
			if err == nil {
				w.receive(ctx, client)
			}
			w.mu.Lock()
			w.client = nil
			w.ready = make(chan struct{})
			w.mu.Unlock()
		}
		if client != nil {
			_ = client.Close()
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(backoff):
		}
		backoff = min(backoff*2, 30*time.Second)
	}
	return ctx.Err()
}

func (w *WebSocket) receive(ctx context.Context, client *protocol.Client) {
	defer client.Close()
	for {
		var inbound Inbound
		select {
		case <-ctx.Done():
			return
		case message, ok := <-client.Notifications:
			if !ok {
				return
			}
			switch message.Method {
			case "device.inbound":
				if json.Unmarshal(message.Params, &inbound) != nil {
					return
				}
			case "event":
				var fact event.Event
				if json.Unmarshal(message.Params, &fact) != nil {
					return
				}
				inbound.Events = []event.Event{fact}
			default:
				return
			}
		}
		select {
		case w.inbound <- inbound:
		case <-ctx.Done():
			return
		}
	}
}

func (w *WebSocket) wait(ctx context.Context) (*protocol.Client, error) {
	for {
		w.mu.Lock()
		client, ready := w.client, w.ready
		w.mu.Unlock()
		if client != nil {
			return client, nil
		}
		select {
		case <-ready:
		case <-ctx.Done():
			return nil, ErrUnavailable
		}
	}
}

func (w *WebSocket) Announce(ctx context.Context, members []group.Member) error {
	w.mu.Lock()
	w.members = append([]group.Member{}, members...)
	w.membersKnown = true
	w.mu.Unlock()
	client, err := w.wait(ctx)
	if err != nil {
		return err
	}
	return w.announce(ctx, client)
}
func (w *WebSocket) announce(ctx context.Context, client *protocol.Client) error {
	w.announceMu.Lock()
	defer w.announceMu.Unlock()
	w.mu.Lock()
	members := append([]group.Member{}, w.members...)
	w.mu.Unlock()
	body, err := json.Marshal(members)
	if err != nil {
		return err
	}
	if w.announcedTo == client && w.announced == string(body) {
		return nil
	}
	request, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	if err := client.Call(request, "device.announce", members, nil); err != nil {
		return err
	}
	w.announcedTo, w.announced = client, string(body)
	return nil
}
func (w *WebSocket) Forward(ctx context.Context, method string, params json.RawMessage) (json.RawMessage, error) {
	request, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	client, err := w.wait(request)
	if err != nil {
		return nil, err
	}
	var result json.RawMessage
	if err = client.Call(request, method, params, &result); err != nil {
		var remote *protocol.Error
		if errors.As(err, &remote) {
			return nil, remote
		}
		return nil, ErrUnavailable
	}
	return result, nil
}
func (w *WebSocket) Inbound() <-chan Inbound { return w.inbound }
func (w *WebSocket) Publish(ctx context.Context, facts []event.Event) error {
	const maximum = (4 << 20) - 1024
	var batch []json.RawMessage
	size := 2
	flush := func() error {
		if len(batch) == 0 {
			return nil
		}
		body, _ := json.Marshal(batch)
		_, err := w.Forward(ctx, "device.publish", body)
		batch = nil
		size = 2
		return err
	}
	for _, fact := range facts {
		body, err := json.Marshal(fact)
		if err != nil {
			return err
		}
		if size+len(body)+1 > maximum {
			if err = flush(); err != nil {
				return err
			}
		}
		if len(body)+2 > maximum {
			digest := sha256.Sum256(body)
			for offset := 0; offset < len(body); offset += 1 << 20 {
				chunk, _ := json.Marshal(protocol.DeviceEventChunk{Event: fact.ID, Digest: hex.EncodeToString(digest[:]), Offset: offset, Total: len(body), Data: body[offset:min(offset+1<<20, len(body))]})
				if _, err = w.Forward(ctx, "device.publishChunk", chunk); err != nil {
					return err
				}
			}
			continue
		}
		batch = append(batch, body)
		size += len(body) + 1
	}
	return flush()
}
func (w *WebSocket) Online() bool { w.mu.Lock(); defer w.mu.Unlock(); return w.client != nil }
