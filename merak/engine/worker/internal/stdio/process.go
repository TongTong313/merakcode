// Package stdio owns external workers' bounded record transport and shared events.
package stdio

import (
	"bufio"
	"context"
	"encoding/json"
	"io"
	"os/exec"
	"sync"
	"time"

	"github.com/TongTong313/merakcode/merak/engine/profile"
	"github.com/TongTong313/merakcode/merak/internal/platform/process"
)

type Process struct {
	Lines  <-chan json.RawMessage
	stdin  io.WriteCloser
	mu     sync.Mutex
	cancel context.CancelFunc
	done   chan struct{}
	err    error
}

func Start(ctx context.Context, dir string, p profile.Product, args []string) (*Process, error) {
	binary, err := exec.LookPath(p.Binary)
	if err != nil {
		return nil, err
	}
	ctx, cancel := context.WithCancel(ctx)
	cmd := process.Command(ctx, dir, binary, args...)
	cmd.Env = cmd.Environ()
	for k, v := range p.Env {
		cmd.Env = append(cmd.Env, k+"="+v)
	}
	cmd.Stderr = io.Discard
	stdin, err := cmd.StdinPipe()
	if err != nil {
		cancel()
		return nil, err
	}
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		stdin.Close()
		cancel()
		return nil, err
	}
	if err := cmd.Start(); err != nil {
		stdin.Close()
		stdout.Close()
		cancel()
		return nil, err
	}
	lines := make(chan json.RawMessage, 32)
	child := &Process{Lines: lines, stdin: stdin, cancel: cancel, done: make(chan struct{})}
	go func() {
		scan := bufio.NewScanner(stdout)
		scan.Buffer(make([]byte, 64<<10), 4<<20)
	read:
		for scan.Scan() {
			line := append(json.RawMessage(nil), scan.Bytes()...)
			select {
			case lines <- line:
			case <-ctx.Done():
				break read
			}
		}
		child.err = scan.Err()
		if child.err != nil {
			cancel()
		}
		if err := cmd.Wait(); child.err == nil {
			child.err = err
		}
		close(lines)
		close(child.done)
	}()
	return child, nil
}
func (p *Process) Write(v any) error {
	p.mu.Lock()
	defer p.mu.Unlock()
	return json.NewEncoder(p.stdin).Encode(v)
}
func (p *Process) Close() error {
	_ = p.stdin.Close()
	select {
	case <-p.done:
	case <-time.After(time.Second):
		p.cancel()
		<-p.done
	}
	p.cancel()
	return p.err
}
func (p *Process) Err() error { <-p.done; return p.err }
