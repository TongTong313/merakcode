// Package command runs plain commands with a prompt on stdin and text on stdout.
package command

import (
	"context"
	"errors"
	"io"
	"os/exec"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/TongTong313/merakcode/merak/engine/event"
	"github.com/TongTong313/merakcode/merak/engine/loop"
	"github.com/TongTong313/merakcode/merak/engine/model"
	"github.com/TongTong313/merakcode/merak/engine/profile"
	"github.com/TongTong313/merakcode/merak/engine/session"
	"github.com/TongTong313/merakcode/merak/engine/store"
	"github.com/TongTong313/merakcode/merak/engine/task"
	"github.com/TongTong313/merakcode/merak/engine/worker"
	"github.com/TongTong313/merakcode/merak/engine/worker/internal/stdio"
	"github.com/TongTong313/merakcode/merak/internal/platform/process"
	"github.com/TongTong313/merakcode/merak/internal/platform/sandbox"
)

type Runner struct {
	Sandbox *sandbox.Launcher
	Store   store.Store
	Bus     *event.Bus
	Product profile.Product
}

func (*Runner) Caps() worker.Caps { return worker.Caps{} }

type run struct{ worker.Run }

func (run) Send(context.Context, loop.Input) error { return worker.ErrUnsupported }
func (r *Runner) Start(ctx context.Context, a worker.Assignment) (worker.Run, error) {
	if a.ReadOnly {
		return nil, errors.New("command workers do not guarantee read-only tools")
	}
	binary, err := exec.LookPath(r.Product.Binary)
	if err != nil {
		return nil, err
	}
	child, err := worker.Launch(ctx, r.Bus, a, func(ctx context.Context, _ <-chan loop.Input) (task.Report, error) { return r.execute(ctx, binary, a) })
	if err != nil {
		return nil, err
	}
	return run{child}, nil
}
func (r *Runner) execute(ctx context.Context, binary string, a worker.Assignment) (report task.Report, runErr error) {
	j, err := stdio.NewJournal(ctx, r.Bus, r.Store, a, "command", "")
	if err != nil {
		return report, err
	}
	emit := j.Emit
	var output strings.Builder
	stop := loop.Answered
	defer func() {
		stop, runErr = worker.Termination(ctx, runErr, stop)
		report = worker.SynthesizeReport(a.Claim.ID, output.String(), stop, runErr)
		ending, cancel := context.WithTimeout(context.WithoutCancel(ctx), 5*time.Second)
		defer cancel()
		parts := []model.Part{{Text: output.String()}}
		_, _ = emit(ending, session.MessageCompleted, session.Completion{Message: model.Message{Role: model.Assistant, Parts: parts}}, "")
		_, err := emit(ending, loop.TurnFinished, loop.Outcome{Stop: stop, Final: parts}, "")
		if runErr == nil {
			runErr = err
		}
	}()
	if _, err := emit(ctx, session.MessageSent, model.Message{Role: model.User, Parts: []model.Part{{Text: a.Packet}}}, a.Cause); err != nil {
		return report, err
	}
	cmd := process.Command(ctx, a.Workdir, binary, r.Product.Args...)
	if r.Sandbox != nil && !r.Sandbox.Disabled {
		a.SandboxProfile, err = stdio.ProductState(a.SandboxProfile)
		if err != nil {
			return report, err
		}
	}
	if r.Sandbox != nil {
		cmd, err = r.Sandbox.Command(ctx, a.SandboxProfile, binary, r.Product.Args...)
		if err != nil {
			return report, err
		}
		cmd.Dir = a.Workdir
	}
	cmd.Env = cmd.Environ()
	for k, v := range r.Product.Env {
		cmd.Env = append(cmd.Env, k+"="+v)
	}
	cmd.Stdin = strings.NewReader(a.Packet)
	cmd.Stderr = io.Discard
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return report, err
	}
	if err := r.Sandbox.Start(cmd, a.SandboxProfile); err != nil {
		return report, err
	}
	buffer := make([]byte, 32<<10)
	var pending []byte
	for {
		n, readErr := stdout.Read(buffer)
		pending = append(pending, buffer[:n]...)
		end := len(pending)
		if readErr == nil {
			for end > 0 && !utf8.Valid(pending[:end]) && len(pending)-end < utf8.UTFMax {
				end--
			}
		}
		if output.Len()+end > 4<<20 {
			runErr = errors.New("command output exceeds 4 MiB")
			break
		}
		if end > 0 {
			text := strings.ToValidUTF8(string(pending[:end]), "�")
			output.WriteString(text)
			pending = append(pending[:0], pending[end:]...)
			if _, err := emit(ctx, session.MessageDelta, model.Chunk{Kind: model.Text, Text: text}, ""); err != nil {
				runErr = err
				break
			}
		}
		if readErr != nil {
			if readErr != io.EOF {
				runErr = readErr
			}
			break
		}
	}
	if runErr != nil {
		_ = cmd.Cancel()
	}
	err = r.Sandbox.Wait(cmd)
	if runErr == nil {
		runErr = err
	}
	return report, runErr
}
