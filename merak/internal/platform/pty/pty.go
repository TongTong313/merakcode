// Package pty runs interactive processes in a native pseudo terminal.
package pty

import (
	"context"
	"errors"
	"os"
	"sync"
)

type Options struct {
	Command    string
	Args       []string
	Directory  string
	Env        []string
	Cols, Rows int
}

type Process struct {
	input, output *os.File
	pid           int
	done          chan struct{}
	closing       chan struct{}
	code          int
	closeOnce     sync.Once
	resizeMu      sync.Mutex
	resize        func(int, int) error
	stop          func()
}

func Start(options Options) (*Process, error) {
	if options.Command == "" {
		return nil, errors.New("terminal command is required")
	}
	if options.Cols == 0 {
		options.Cols = 80
	}
	if options.Rows == 0 {
		options.Rows = 24
	}
	if !validSize(options.Cols, options.Rows) {
		return nil, errors.New("invalid terminal size")
	}
	return start(options)
}

func validSize(cols, rows int) bool              { return cols > 0 && rows > 0 && cols <= 32767 && rows <= 32767 }
func (p *Process) PID() int                      { return p.pid }
func (p *Process) Read(body []byte) (int, error) { return p.output.Read(body) }
func (p *Process) inactive() bool {
	select {
	case <-p.done:
		return true
	default:
	}
	select {
	case <-p.closing:
		return true
	default:
		return false
	}
}
func (p *Process) Write(body []byte) (int, error) {
	if p.inactive() {
		return len(body), nil
	}
	n, err := p.input.Write(body)
	if err != nil && p.inactive() {
		return len(body), nil
	}
	return n, err
}
func (p *Process) Resize(cols, rows int) error {
	p.resizeMu.Lock()
	defer p.resizeMu.Unlock()
	if p.inactive() {
		return nil
	}
	if !validSize(cols, rows) {
		return errors.New("invalid terminal size")
	}
	return p.resize(cols, rows)
}
func (p *Process) CloseOutput() error {
	err := p.output.Close()
	if errors.Is(err, os.ErrClosed) {
		return nil
	}
	return err
}
func (p *Process) Close() error {
	p.closeOnce.Do(func() {
		close(p.closing)
		p.resizeMu.Lock()
		defer p.resizeMu.Unlock()
		p.stop()
	})
	return nil
}
func (p *Process) Wait(ctx context.Context) (int, error) {
	select {
	case <-p.done:
		return p.code, nil
	case <-ctx.Done():
		return 0, ctx.Err()
	}
}
