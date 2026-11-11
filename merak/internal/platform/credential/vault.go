package credential

import (
	"context"
	"os"
	"sync"
)

// Vault keeps secrets: *Store is one, and so is the in-memory one. Values never go into a database, an event or a
// configuration file.
type Vault interface {
	Get(ctx context.Context, key string) ([]byte, error)
	Set(ctx context.Context, key string, value []byte) error
	Delete(ctx context.Context, key string) error
}

// Memory is a Vault that forgets everything when the process ends; an engine without a data directory uses it.
type Memory struct {
	mu    sync.Mutex
	items map[string][]byte
}

func NewMemory() *Memory { return &Memory{} }

func (m *Memory) Get(_ context.Context, key string) ([]byte, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	value, ok := m.items[key]
	if !ok {
		return nil, os.ErrNotExist
	}
	return append([]byte(nil), value...), nil
}

func (m *Memory) Set(_ context.Context, key string, value []byte) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.items == nil {
		m.items = map[string][]byte{}
	}
	m.items[key] = append([]byte(nil), value...)
	return nil
}

func (m *Memory) Delete(_ context.Context, key string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	delete(m.items, key)
	return nil
}
