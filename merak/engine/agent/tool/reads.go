package tool

import (
	"crypto/sha256"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
)

// Reads tracks the contents observed by one session, including its own writes.
type Reads struct {
	mu    sync.Mutex
	files map[string][32]byte
}

func readKey(path string) string {
	if absolute, err := filepath.Abs(path); err == nil {
		path = absolute
	}
	if resolved, err := filepath.EvalSymlinks(path); err == nil {
		path = resolved
	}
	if runtime.GOOS == "windows" {
		path = strings.ToLower(path)
	}
	return path
}

func (r *Reads) remember(path string, body []byte) {
	if r == nil {
		return
	}
	key := readKey(path)
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.files == nil {
		r.files = make(map[string][32]byte)
	}
	r.files[key] = sha256.Sum256(body)
}

func (r *Reads) current(path string, body []byte) bool {
	if r == nil {
		return false
	}
	key := readKey(path)
	r.mu.Lock()
	defer r.mu.Unlock()
	previous, ok := r.files[key]
	return ok && previous == sha256.Sum256(body)
}
