//go:build !windows

package pty

import (
	"os"
	"os/exec"
	"syscall"

	native "github.com/creack/pty"
)

func start(options Options) (*Process, error) {
	command := exec.Command(options.Command, options.Args...)
	command.Dir, command.Env = options.Directory, options.Env
	if command.Env == nil {
		command.Env = os.Environ()
	}
	file, err := native.StartWithSize(command, &native.Winsize{Cols: uint16(options.Cols), Rows: uint16(options.Rows)})
	if err != nil {
		return nil, err
	}
	p := &Process{input: file, output: file, pid: command.Process.Pid, done: make(chan struct{}), closing: make(chan struct{})}
	p.resize = func(cols, rows int) error {
		return native.Setsize(file, &native.Winsize{Cols: uint16(cols), Rows: uint16(rows)})
	}
	p.stop = func() { _ = syscall.Kill(-p.pid, syscall.SIGKILL); _ = file.Close(); <-p.done }
	go func() { _ = command.Wait(); p.code = command.ProcessState.ExitCode(); close(p.done) }()
	return p, nil
}
