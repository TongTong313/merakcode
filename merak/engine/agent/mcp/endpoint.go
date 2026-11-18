package mcp

import (
	"bufio"
	"context"
	"crypto/rand"
	"crypto/subtle"
	"encoding/hex"
	"encoding/json"
	"errors"
	"net"
	"sync"
	"time"
)

// Endpoint grants one external run access to one member's tools.
// Its token is independent of the engine protocol token.
type Endpoint struct {
	Address     string
	Token       string
	Port        int
	listener    net.Listener
	cancel      context.CancelFunc
	once        sync.Once
	workers     sync.WaitGroup
	mu          sync.Mutex
	connections map[net.Conn]struct{}
}

type handshake struct{ Token, Role, Scope string }

func Listen(ctx context.Context, server *Server, role, scope string) (*Endpoint, error) {
	if scope == "" || role != "worker" && role != "leader" {
		return nil, errors.New("MCP member scope is required")
	}
	var secret [32]byte
	if _, err := rand.Read(secret[:]); err != nil {
		return nil, err
	}
	listener, err := net.Listen("tcp4", "127.0.0.1:0")
	if err != nil {
		return nil, err
	}
	ctx, cancel := context.WithCancel(ctx)
	e := &Endpoint{Address: listener.Addr().String(), Token: hex.EncodeToString(secret[:]), Port: listener.Addr().(*net.TCPAddr).Port, listener: listener, cancel: cancel, connections: make(map[net.Conn]struct{})}
	e.workers.Go(func() {
		for {
			connection, err := listener.Accept()
			if err != nil {
				return
			}
			e.mu.Lock()
			if ctx.Err() != nil {
				e.mu.Unlock()
				connection.Close()
				return
			}
			e.connections[connection] = struct{}{}
			e.mu.Unlock()
			e.workers.Go(func() {
				defer connection.Close()
				defer func() { e.mu.Lock(); delete(e.connections, connection); e.mu.Unlock() }()
				_ = connection.SetDeadline(time.Now().Add(5 * time.Second))
				reader := bufio.NewReaderSize(connection, 4096)
				line, err := reader.ReadSlice('\n')
				var hello handshake
				if err != nil || json.Unmarshal(line, &hello) != nil || subtle.ConstantTimeCompare([]byte(hello.Token), []byte(e.Token)) != 1 || hello.Role != role || hello.Scope != scope {
					return
				}
				if _, err := connection.Write([]byte("ok\n")); err != nil {
					return
				}
				_ = connection.SetDeadline(time.Time{})
				_ = server.Serve(ctx, bufferedConnection{Conn: connection, reader: reader}, connection)
			})
		}
	})
	context.AfterFunc(ctx, func() { e.Close() })
	return e, nil
}

func (e *Endpoint) Close() error {
	e.once.Do(func() {
		e.cancel()
		_ = e.listener.Close()
		e.mu.Lock()
		for connection := range e.connections {
			_ = connection.Close()
		}
		e.mu.Unlock()
		e.workers.Wait()
	})
	return nil
}

type bufferedConnection struct {
	net.Conn
	reader *bufio.Reader
}

func (c bufferedConnection) Read(p []byte) (int, error) { return c.reader.Read(p) }
