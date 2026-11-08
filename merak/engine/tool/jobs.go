package tool

import (
	"bytes"
	"context"
	"errors"
	"sync"
	"time"

	"github.com/TongTong313/merakcode/merak/engine/event"
	"github.com/TongTong313/merakcode/merak/engine/model"
	"github.com/TongTong313/merakcode/merak/internal/platform/process"
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

func (j *Jobs) start(parent context.Context, workdir, command string) (Result, error) {
	if j == nil {
		return failure(errors.New("background commands are unavailable")), nil
	}
	j.mu.Lock()
	defer j.mu.Unlock()
	if j.closed {
		return failure(errors.New("session has closed")), nil
	}
	ctx, cancel := context.WithTimeout(parent, 2*time.Minute)
	cmd, err := process.Shell(ctx, workdir, command)
	if err != nil {
		cancel()
		return failure(err), nil
	}
	id := string(event.NewID())
	result := Result{JobID: id, Running: true, Parts: []model.Part{{Text: "Background command started: " + id}}}
	current := &job{cancel: cancel, done: make(chan struct{}), result: result}
	cmd.Stdout, cmd.Stderr = current, current
	if err := cmd.Start(); err != nil {
		cancel()
		return failure(err), nil
	}
	if j.jobs == nil {
		j.jobs = make(map[string]*job)
	}
	j.jobs[id] = current
	go func() {
		err := cmd.Wait()
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
		}
		current.mu.Unlock()
		cancel()
		close(current.done)
	}()
	return result, nil
}

func (j *Jobs) output(id string) Result {
	if j == nil {
		return failure(errors.New("background commands are unavailable"))
	}
	j.mu.Lock()
	current, ok := j.jobs[id]
	j.mu.Unlock()
	if !ok {
		return failure(errors.New("unknown background command"))
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
