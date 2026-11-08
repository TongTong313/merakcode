// Package worker runs assignments through a shared event and report contract.
package worker

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"strings"

	"github.com/TongTong313/merakcode/merak/engine/event"
	"github.com/TongTong313/merakcode/merak/engine/loop"
	"github.com/TongTong313/merakcode/merak/engine/task"
)

type Kind string

const (
	KindBuiltin    Kind = "builtin"
	KindClaudeCode Kind = "claude-code"
	KindCommand    Kind = "command"
	KindCodex      Kind = "codex"
	KindOpenCode   Kind = "opencode"
	KindPi         Kind = "pi"
	KindACP        Kind = "acp"
)

type Caps struct {
	Steer      bool `json:"steer"`
	Permission bool `json:"permission"`
}

var ErrUnsupported = errors.New("worker does not support this operation")

type Assignment struct {
	ReadOnly bool
	Claim    task.Claim
	Packet   string
	Workdir  string
	Session  event.ID
	Scope    event.Scope
	Cause    event.ID
}
type Runner interface {
	Start(context.Context, Assignment) (Run, error)
	Caps() Caps
}
type Run interface {
	Events() <-chan event.Event
	Send(context.Context, loop.Input) error
	Cancel(context.Context) error
	Wait(context.Context) (task.Report, error)
}

type running struct {
	ctx    context.Context
	cancel context.CancelFunc
	events <-chan event.Event
	inputs chan loop.Input
	done   chan struct{}
	report task.Report
	err    error
}

// Launch owns cancellation and event delivery for both in-process and external workers.
func Launch(ctx context.Context, bus *event.Bus, a Assignment, execute func(context.Context, <-chan loop.Input) (task.Report, error)) (Run, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	if bus == nil || a.Session == "" {
		return nil, errors.New("worker bus and session are required")
	}
	ctx, cancel := context.WithCancel(ctx)
	events, stop := bus.Subscribe(event.Filter{Scope: event.Scope{Session: a.Session}})
	r := &running{ctx: ctx, cancel: cancel, events: events, inputs: make(chan loop.Input, 16), done: make(chan struct{})}
	go func() {
		defer cancel()
		r.report, r.err = execute(ctx, r.inputs)
		stop()
		close(r.done)
	}()
	return r, nil
}
func (r *running) Events() <-chan event.Event { return r.events }
func (r *running) Send(ctx context.Context, input loop.Input) error {
	select {
	case <-r.done:
		return errors.New("worker has finished")
	default:
	}
	select {
	case r.inputs <- input:
		return nil
	case <-ctx.Done():
		return ctx.Err()
	case <-r.ctx.Done():
		return r.ctx.Err()
	}
}
func (r *running) Cancel(ctx context.Context) error {
	r.cancel()
	select {
	case <-r.done:
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}
func (r *running) Wait(ctx context.Context) (task.Report, error) {
	select {
	case <-r.done:
		return r.report, r.err
	case <-ctx.Done():
		return task.Report{}, ctx.Err()
	}
}

// ReportFromText accepts the small report schema or bounds a synthesized free-text report.
func ReportFromText(claim event.ID, text string, stop loop.StopReason, err error) task.Report {
	var report task.Report
	decoder := json.NewDecoder(strings.NewReader(text))
	decoder.DisallowUnknownFields()
	if err == nil && stop == loop.Answered && decoder.Decode(&report) == nil && decoder.Decode(new(any)) == io.EOF && report.Validate() == nil {
		switch report.Verdict {
		case task.VerdictDone, task.VerdictBlocked, task.VerdictNeedsReview, task.VerdictFailed:
			report.Claim, report.Synthesized = claim, false
			return report
		}
	}
	return SynthesizeReport(claim, text, stop, err)
}

// SynthesizeReport bounds plain output without interpreting it as a structured report.
func SynthesizeReport(claim event.ID, text string, stop loop.StopReason, err error) task.Report {
	verdict := task.VerdictDone
	if stop == loop.Cancelled || errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded) {
		verdict = task.VerdictBlocked
	} else if err != nil || stop == loop.Failed {
		verdict = task.VerdictFailed
	}
	if strings.TrimSpace(text) == "" {
		text = "Worker ended without a report."
	}
	runes := []rune(text)
	if len(runes) > 1200 {
		text = string(runes[:1200])
	}
	return task.Report{Claim: claim, Verdict: verdict, Summary: text, Synthesized: true}
}
