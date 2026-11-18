package tool

import (
	"bytes"
	"context"
	"errors"
	"sync"
	"time"

	"github.com/TongTong313/merakcode/merak/engine/agent/model"
	"github.com/TongTong313/merakcode/merak/engine/infra/event"
	"github.com/TongTong313/merakcode/merak/engine/infra/process"
	"github.com/TongTong313/merakcode/merak/engine/infra/sandbox"
)

// Jobs owns background commands for one session and joins them on Close.
type Jobs struct {
	mu     sync.Mutex
	jobs   map[string]*job
	closed bool
}

type job struct {
	mu     sync.Mutex
	output bytes.Buffer
	result Result
	cancel context.CancelFunc
	done   chan struct{}
}

func (j *job) Write(body []byte) (int, error) {
	j.mu.Lock()
	defer j.mu.Unlock()
	return j.output.Write(body)
}

func (j *Jobs) start(parent context.Context, env Env, command string) (Result, error) {
	if j == nil {
		return Failure(errors.New("background commands are unavailable")), nil
	}
	j.mu.Lock()
	defer j.mu.Unlock()
	if j.closed {
		return Failure(errors.New("session has closed")), nil
	}
	ctx, cancel := context.WithTimeout(parent, 2*time.Minute)
	cmd, err := process.Shell(ctx, env.Workdir, command)
	if err != nil {
		cancel()
		return Failure(err), nil
	}
	if env.Sandbox != nil {
		cmd, err = env.Sandbox.Command(ctx, env.SandboxProfile, cmd.Path, cmd.Args[1:]...)
		if err != nil {
			cancel()
			return Failure(err), nil
		}
		cmd.Dir = env.Workdir
	}
	id := string(event.NewID())
	result := Result{JobID: id, Running: true, Parts: []model.Part{{Text: "Background command started: " + id}}}
	current := &job{cancel: cancel, done: make(chan struct{}), result: result}
	cmd.Stdout, cmd.Stderr = current, current
	if err := env.Sandbox.Start(cmd, env.SandboxProfile); err != nil {
		cancel()
		return Failure(err), nil
	}
	if j.jobs == nil {
		j.jobs = make(map[string]*job)
	}
	j.jobs[id] = current
	go func() {
		err := env.Sandbox.Wait(cmd)
		current.mu.Lock()
		exit := cmd.ProcessState.ExitCode()
		if ctx.Err() != nil {
			exit = -1
			current.output.WriteString("\nCommand timed out or was cancelled.")
		}
		current.result.Running = false
		current.result.ExitCode = &exit
		if err != nil {
			current.result.IsError = true
			current.result.Code = "MRK-5001"
			var denied *sandbox.DenialError
			if errors.As(err, &denied) {
				current.result.Code = "MRK-5009"
				current.output.WriteString("\n" + denied.Error())
			}
			var protected *sandbox.ProtectionError
			if errors.As(err, &protected) {
				current.result.Code = "MRK-5007"
				current.output.WriteString("\n" + protected.Error())
			}
		}
		current.mu.Unlock()
		cancel()
		close(current.done)
	}()
	return result, nil
}

func (j *Jobs) output(id string) Result {
	if j == nil {
		return Failure(errors.New("background commands are unavailable"))
	}
	j.mu.Lock()
	current, ok := j.jobs[id]
	j.mu.Unlock()
	if !ok {
		return Failure(errors.New("unknown background command"))
	}
	current.mu.Lock()
	defer current.mu.Unlock()
	result := current.result
	result.Parts = []model.Part{{Text: current.output.String()}}
	if result.ExitCode != nil {
		exit := *result.ExitCode
		result.ExitCode = &exit
	}
	return result
}

func (j *Jobs) Close() {
	j.mu.Lock()
	j.closed = true
	var pending []*job
	for _, current := range j.jobs {
		pending = append(pending, current)
		current.cancel()
	}
	j.mu.Unlock()
	for _, current := range pending {
		<-current.done
	}
}
