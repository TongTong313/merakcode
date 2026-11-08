// Package terminal owns interactive shells and their bounded replay buffers.
package terminal

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"path/filepath"
	"sort"
	"sync"
	"time"

	"github.com/TongTong313/merakcode/merak/engine/event"
	"github.com/TongTong313/merakcode/merak/internal/platform/pty"
)

const (
	Created  event.Type = "terminal.created"
	Updated  event.Type = "terminal.updated"
	Exited   event.Type = "terminal.exited"
	Deleted  event.Type = "terminal.deleted"
	capacity            = 2 << 20
)

type Size struct {
	Cols int `json:"cols"`
	Rows int `json:"rows"`
}
type Info struct {
	ID        event.ID `json:"id"`
	Directory string   `json:"directory"`
	Command   string   `json:"command"`
	Args      []string `json:"args"`
	Title     string   `json:"title"`
	Size      Size     `json:"size"`
	PID       int      `json:"pid"`
	Status    string   `json:"status"`
	ExitCode  *int     `json:"exitCode,omitempty"`
}
type CreateOptions struct {
	Directory string   `json:"directory"`
	Command   string   `json:"command,omitempty"`
	Args      []string `json:"args,omitempty"`
	Title     string   `json:"title,omitempty"`
	Size      Size     `json:"size"`
}
type UpdateOptions struct {
	Title *string `json:"title,omitempty"`
	Size  *Size   `json:"size,omitempty"`
}

func init() {
	event.Register[Info](Created)
	event.Register[Info](Updated)
	event.Register[Info](Exited)
	event.Register[Info](Deleted)
}

type Manager struct {
	mu     sync.Mutex
	items  map[event.ID]*terminal
	closed bool
	bus    *event.Bus
	newID  func() event.ID
}
type terminal struct {
	mu      sync.Mutex
	info    Info
	process *pty.Process
	buffer  []byte
	cursor  uint64
	changed chan struct{}
	done    chan struct{}
}

func New(bus *event.Bus, newID func() event.ID) *Manager {
	return &Manager{items: make(map[event.ID]*terminal), bus: bus, newID: newID}
}
func (m *Manager) publish(ctx context.Context, kind event.Type, info Info) error {
	body, _ := json.Marshal(info)
	_, err := m.bus.Publish(ctx, event.Event{Stream: event.Stream("terminal:" + info.ID), Type: kind, Actor: event.Actor{Kind: event.ActorHuman}, Payload: body})
	return err
}
func (m *Manager) Create(ctx context.Context, options CreateOptions) (Info, error) {
	if err := ctx.Err(); err != nil {
		return Info{}, err
	}
	directory, err := filepath.Abs(options.Directory)
	if err != nil {
		return Info{}, err
	}
	command, args, env, err := shell(options.Command, options.Args)
	if err != nil {
		return Info{}, err
	}
	if options.Size.Cols == 0 {
		options.Size.Cols = 80
	}
	if options.Size.Rows == 0 {
		options.Size.Rows = 24
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.closed {
		return Info{}, errors.New("terminal manager is closed")
	}
	process, err := pty.Start(pty.Options{Directory: directory, Command: command, Args: args, Env: env, Cols: options.Size.Cols, Rows: options.Size.Rows})
	if err != nil {
		return Info{}, err
	}
	info := Info{ID: m.newID(), Directory: directory, Command: command, Args: append([]string{}, args...), Title: options.Title, Size: options.Size, PID: process.PID(), Status: "running"}
	if info.Title == "" {
		info.Title = filepath.Base(command)
	}
	if err := m.publish(ctx, Created, info); err != nil {
		process.Close()
		return Info{}, err
	}
	item := &terminal{info: info, process: process, buffer: make([]byte, capacity), changed: make(chan struct{}), done: make(chan struct{})}
	m.items[info.ID] = item
	go m.collect(item)
	return info, nil
}
func (m *Manager) collect(item *terminal) {
	defer close(item.done)
	outputDone := make(chan struct{})
	go func() {
		defer close(outputDone)
		body := make([]byte, 32<<10)
		for {
			n, err := item.process.Read(body)
			if n > 0 {
				item.append(body[:n])
			}
			if err != nil {
				return
			}
		}
	}()
	code, _ := item.process.Wait(context.Background())
	_ = item.process.Close()
	<-outputDone
	item.mu.Lock()
	item.info.Status, item.info.ExitCode = "exited", &code
	info := item.info
	item.signal()
	item.mu.Unlock()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	_ = m.publish(ctx, Exited, info)
}
func (t *terminal) signal() { close(t.changed); t.changed = make(chan struct{}) }
func (t *terminal) append(body []byte) {
	t.mu.Lock()
	defer t.mu.Unlock()
	for len(body) > 0 {
		offset := int(t.cursor % capacity)
		n := copy(t.buffer[offset:], body)
		t.cursor += uint64(n)
		body = body[n:]
	}
	t.signal()
}
func (m *Manager) lookup(id event.ID) (*terminal, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	item := m.items[id]
	if item == nil {
		return nil, errors.New("unknown terminal")
	}
	return item, nil
}
func (m *Manager) Get(id event.ID) (Info, error) {
	item, err := m.lookup(id)
	if err != nil {
		return Info{}, err
	}
	item.mu.Lock()
	defer item.mu.Unlock()
	return item.info, nil
}
func (m *Manager) List(directory string) []Info {
	m.mu.Lock()
	defer m.mu.Unlock()
	result := []Info{}
	for _, item := range m.items {
		item.mu.Lock()
		if directory == "" || filepath.Clean(directory) == item.info.Directory {
			result = append(result, item.info)
		}
		item.mu.Unlock()
	}
	sort.Slice(result, func(i, j int) bool { return result[i].ID < result[j].ID })
	return result
}
func (m *Manager) Write(id event.ID, body []byte) error {
	item, err := m.lookup(id)
	if err != nil {
		return err
	}
	_, err = item.process.Write(body)
	return err
}
func (m *Manager) Update(ctx context.Context, id event.ID, options UpdateOptions) (Info, error) {
	item, err := m.lookup(id)
	if err != nil {
		return Info{}, err
	}
	item.mu.Lock()
	defer item.mu.Unlock()
	if options.Size != nil {
		if err := item.process.Resize(options.Size.Cols, options.Size.Rows); err != nil {
			return Info{}, err
		}
		item.info.Size = *options.Size
	}
	if options.Title != nil {
		item.info.Title = *options.Title
	}
	return item.info, m.publish(ctx, Updated, item.info)
}
func (m *Manager) Remove(ctx context.Context, id event.ID) error {
	item, err := m.lookup(id)
	if err != nil {
		return err
	}
	_ = item.process.Close()
	select {
	case <-item.done:
	case <-ctx.Done():
		return ctx.Err()
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.items[id] != item {
		return nil
	}
	item.mu.Lock()
	info := item.info
	item.mu.Unlock()
	if err := m.publish(ctx, Deleted, info); err != nil {
		return err
	}
	delete(m.items, id)
	return nil
}
func (m *Manager) CloseProject(ctx context.Context, directory string) error {
	for _, info := range m.List(directory) {
		if err := m.Remove(ctx, info.ID); err != nil {
			return err
		}
	}
	return nil
}
func (m *Manager) Close() {
	m.mu.Lock()
	m.closed = true
	m.mu.Unlock()
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	_ = m.CloseProject(ctx, "")
}

type Chunk struct {
	Data   []byte
	Cursor uint64
}
type Subscription struct {
	terminal *terminal
	cursor   uint64
	first    bool
	closed   chan struct{}
	once     sync.Once
}

func (m *Manager) Subscribe(id event.ID, cursor uint64) (*Subscription, error) {
	item, err := m.lookup(id)
	if err != nil {
		return nil, err
	}
	item.mu.Lock()
	defer item.mu.Unlock()
	if cursor > item.cursor {
		return nil, errors.New("terminal cursor is in the future")
	}
	return &Subscription{terminal: item, cursor: cursor, first: true, closed: make(chan struct{})}, nil
}
func (s *Subscription) Close() { s.once.Do(func() { close(s.closed) }) }
func (s *Subscription) Next(ctx context.Context) (Chunk, error) {
	for {
		select {
		case <-s.closed:
			return Chunk{}, io.EOF
		case <-ctx.Done():
			return Chunk{}, ctx.Err()
		default:
		}
		t := s.terminal
		t.mu.Lock()
		end := t.cursor
		if end-s.cursor > capacity {
			s.cursor = end - capacity
		}
		if s.first || s.cursor < end {
			body := make([]byte, int(end-s.cursor))
			offset := int(s.cursor % capacity)
			n := copy(body, t.buffer[offset:])
			copy(body[n:], t.buffer[:len(body)-n])
			s.cursor = end
			s.first = false
			t.mu.Unlock()
			return Chunk{Data: body, Cursor: end}, nil
		}
		changed, exited := t.changed, t.info.Status == "exited"
		t.mu.Unlock()
		if exited {
			return Chunk{}, io.EOF
		}
		select {
		case <-changed:
		case <-s.closed:
			return Chunk{}, io.EOF
		case <-ctx.Done():
			return Chunk{}, ctx.Err()
		}
	}
}
