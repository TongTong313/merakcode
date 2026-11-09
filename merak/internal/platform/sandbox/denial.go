package sandbox

import (
	"io"
	"strings"
	"sync"

	"github.com/TongTong313/merakcode/merak/internal/platform/secret"
)

type DenialError struct{ Details string }

func (e *DenialError) Error() string { return "MRK-5009: " + e.Details }

type denialCapture struct {
	mu      sync.Mutex
	pending string
	denied  []string
	size    int
}

type denialOutput struct {
	target  io.Writer
	capture *denialCapture
	stderr  bool
}

func (w denialOutput) Write(body []byte) (int, error) {
	w.capture.mu.Lock()
	defer w.capture.mu.Unlock()
	if w.stderr {
		w.capture.pending += string(body)
		for {
			line, rest, found := strings.Cut(w.capture.pending, "\n")
			if !found {
				break
			}
			w.capture.line(line)
			w.capture.pending = rest
		}
		if len(w.capture.pending) > 8192 {
			w.capture.pending = w.capture.pending[len(w.capture.pending)-8192:]
		}
	}
	if w.target == nil {
		return len(body), nil
	}
	return w.target.Write(body)
}

func (c *denialCapture) line(line string) {
	if c.size >= 32768 {
		return
	}
	lower := strings.ToLower(line)
	for _, marker := range []string{"permission denied", "access is denied", "operation not permitted", "eacces", "eperm"} {
		if strings.Contains(lower, marker) {
			line = secret.Redact(strings.TrimSpace(line))
			if len(line) > 8192 {
				line = line[:8192]
			}
			c.denied = append(c.denied, line)
			c.size += len(line)
			return
		}
	}
}

func (c *denialCapture) failure() *DenialError {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.line(c.pending)
	if len(c.denied) == 0 {
		return nil
	}
	return &DenialError{Details: strings.Join(c.denied, "\n")}
}
