// Package credential stores engine-owned secrets in the system vault with a private file fallback.
package credential

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"sync"
)

type Store struct {
	directory string
	fileOnly  bool
	mu        sync.Mutex
}
type entry struct {
	System bool   `json:"system"`
	Value  []byte `json:"value,omitempty"`
}

func New(directory string) *Store     { return &Store{directory: directory} }
func NewFile(directory string) *Store { return &Store{directory: directory, fileOnly: true} }
func (s *Store) identity(key string) (string, string, error) {
	if key == "" {
		return "", "", errors.New("credential key is required")
	}
	directory, err := filepath.Abs(s.directory)
	if err != nil {
		return "", "", err
	}
	hash := sha256.Sum256([]byte(key))
	name := hex.EncodeToString(hash[:])
	target := sha256.Sum256([]byte(directory + "\x00" + key))
	return filepath.Join(directory, name+".json"), "MerakCode:" + hex.EncodeToString(target[:]), nil
}
func (s *Store) Get(ctx context.Context, key string) ([]byte, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	path, target, err := s.identity(key)
	if err != nil {
		return nil, err
	}
	body, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	var saved entry
	if err = json.Unmarshal(body, &saved); err != nil {
		return nil, err
	}
	if saved.System {
		return systemGet(ctx, target)
	}
	return saved.Value, nil
}
func (s *Store) Set(ctx context.Context, key string, value []byte) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if err := ctx.Err(); err != nil {
		return err
	}
	path, target, err := s.identity(key)
	if err != nil {
		return err
	}
	if err = os.MkdirAll(filepath.Dir(path), 0700); err != nil {
		return err
	}
	if err = secureDirectory(filepath.Dir(path)); err != nil {
		return err
	}
	saved := entry{Value: value}
	if !s.fileOnly {
		var previous entry
		body, readErr := os.ReadFile(path)
		if readErr != nil && !errors.Is(readErr, os.ErrNotExist) {
			return readErr
		}
		if readErr == nil {
			if err := json.Unmarshal(body, &previous); err != nil {
				return err
			}
		}
		if systemSet(ctx, target, value) == nil {
			if previous.System {
				return nil
			}
			saved = entry{System: true}
		}
	}
	if err = ctx.Err(); err != nil {
		return err
	}
	body, err := json.Marshal(saved)
	if err != nil {
		return err
	}
	file, err := os.CreateTemp(filepath.Dir(path), ".credential-*")
	if err != nil {
		return err
	}
	defer os.Remove(file.Name())
	defer file.Close()
	if _, err = file.Write(body); err != nil {
		return err
	}
	if err = file.Sync(); err != nil {
		return err
	}
	if err = file.Close(); err != nil {
		return err
	}
	return os.Rename(file.Name(), path)
}
func (s *Store) Delete(ctx context.Context, key string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if err := ctx.Err(); err != nil {
		return err
	}
	path, target, err := s.identity(key)
	if err != nil {
		return err
	}
	body, err := os.ReadFile(path)
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if err != nil {
		return err
	}
	var saved entry
	if err = json.Unmarshal(body, &saved); err != nil {
		return err
	}
	if saved.System {
		if err = systemDelete(ctx, target); err != nil && !errors.Is(err, os.ErrNotExist) {
			return err
		}
	}
	return os.Remove(path)
}
