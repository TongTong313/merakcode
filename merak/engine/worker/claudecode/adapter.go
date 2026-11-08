package claudecode

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"io"
	"os/exec"
	"strings"
	"sync"
	"time"

	"github.com/TongTong313/merakcode/merak/engine/event"
	"github.com/TongTong313/merakcode/merak/engine/loop"
	"github.com/TongTong313/merakcode/merak/engine/model"
	"github.com/TongTong313/merakcode/merak/engine/profile"
	"github.com/TongTong313/merakcode/merak/engine/session"
	"github.com/TongTong313/merakcode/merak/engine/store"
	"github.com/TongTong313/merakcode/merak/engine/task"
	"github.com/TongTong313/merakcode/merak/engine/tool"
	"github.com/TongTong313/merakcode/merak/engine/worker"
	"github.com/TongTong313/merakcode/merak/internal/platform/process"
)

type Runner struct {
	Bus     *event.Bus
	Store   store.Store
	Product profile.Product
	System  string
}

func (*Runner) Caps() worker.Caps { return worker.Caps{Steer: true} }
func (r *Runner) Start(ctx context.Context, a worker.Assignment) (worker.Run, error) {
	binary := r.Product.Binary
	if binary == "" {
		binary = "claude"
	}
	resolved, err := exec.LookPath(binary)
	if err != nil {
		return nil, err
	}
	return worker.Launch(ctx, r.Bus, a, func(ctx context.Context, inputs <-chan loop.Input) (task.Report, error) {
		return r.execute(ctx, resolved, a, inputs)
	})
}

func (r *Runner) execute(ctx context.Context, binary string, a worker.Assignment, inputs <-chan loop.Input) (report task.Report, runErr error) {
	previous, err := r.loadSession(ctx, a)
	if err != nil {
		return report, err
	}
	scope := a.Scope
	scope.Session = a.Session
	actor := event.Actor{Kind: event.ActorAgent, ID: a.Claim.Member}
	emit := func(ctx context.Context, kind event.Type, payload any, cause event.ID) (event.Event, error) {
		body, err := json.Marshal(payload)
		if err != nil {
			return event.Event{}, err
		}
		return r.Bus.Publish(ctx, event.Event{Stream: event.Stream("session:" + a.Session), Type: kind, Scope: scope, Actor: actor, Cause: cause, Payload: body})
	}
	state := session.State{ID: a.Session, Scope: scope, Config: session.Config{Provider: "claude-code", Model: r.Product.Model, Workdir: a.Workdir}}
	if previous.Product == "" {
		if _, err := emit(ctx, session.Created, state, ""); err != nil {
			return report, err
		}
	}
	started, err := emit(ctx, loop.TurnStarted, session.Started{}, "")
	if err != nil {
		return report, err
	}
	scope.Turn = started.ID
	last := ""
	stop := loop.Answered
	called := map[string]event.Event{}
	usages := map[string]model.Usage{}
	var usage model.Usage
	var order []string
	defer func() {
		if ctx.Err() != nil {
			stop, runErr = loop.Cancelled, ctx.Err()
		} else if runErr != nil {
			stop = loop.Failed
		}
		report = worker.ReportFromText(a.Claim.ID, last, stop, runErr)
		report.Usage = usage
		ending, cancel := context.WithTimeout(context.WithoutCancel(ctx), 5*time.Second)
		defer cancel()
		for _, id := range order {
			fact, ok := called[id]
			if !ok {
				continue
			}
			call, _ := event.Decode[model.ToolCall](fact)
			_, _ = emit(ending, tool.Completed, tool.Completion{CallID: id, Name: call.Name, Result: tool.Result{IsError: true, Code: "MRK-5003"}}, fact.ID)
		}
		_, err := emit(ending, loop.TurnFinished, loop.Outcome{Stop: stop, Final: []model.Part{{Text: last}}, Usage: usage}, "")
		if runErr == nil {
			runErr = err
		}
	}()
	if _, err := emit(ctx, session.MessageSent, model.Message{Role: model.User, Parts: []model.Part{{Text: a.Packet}}}, a.Cause); err != nil {
		return report, err
	}
	args := append([]string{"-p", "--output-format", "stream-json", "--input-format", "stream-json", "--verbose", "--include-partial-messages"}, r.Product.Args...)
	if a.ReadOnly {
		args = append(args, "--tools", "Read,Grep,Glob")
	}
	if previous.Product != "" {
		args = append(args, "--resume", previous.Product)
	}
	args = append(args, "--append-system-prompt", strings.TrimSpace(r.System+"\nAt the end, return a JSON object with verdict (done, blocked, needs_review, or failed) and summary (at most 1200 characters)."))
	if r.Product.Model != "" {
		args = append(args, "--model", r.Product.Model)
	}
	cmd := process.Command(ctx, a.Workdir, binary, args...)
	cmd.Env = cmd.Environ()
	for key, value := range r.Product.Env {
		cmd.Env = append(cmd.Env, key+"="+value)
	}
	cmd.Stderr = io.Discard
	stdin, err := cmd.StdinPipe()
	if err != nil {
		return report, err
	}
	defer stdin.Close()
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return report, err
	}
	if err := cmd.Start(); err != nil {
		return report, err
	}
	var writeMu sync.Mutex
	write := func(parts []model.Part) error {
		var text strings.Builder
		for _, part := range parts {
			text.WriteString(part.Text)
		}
		writeMu.Lock()
		defer writeMu.Unlock()
		return json.NewEncoder(stdin).Encode(map[string]any{"type": "user", "message": map[string]any{"role": "user", "content": text.String()}, "parent_tool_use_id": nil})
	}
	if err := write([]model.Part{{Text: a.Packet}}); err != nil {
		_ = cmd.Process.Kill()
		_ = cmd.Wait()
		return report, err
	}
	writerCtx, stopWriter := context.WithCancel(ctx)
	defer stopWriter()
	writerDone := make(chan struct{})
	go func() {
		defer close(writerDone)
		for {
			select {
			case <-writerCtx.Done():
				return
			case input := <-inputs:
				if write(input.Parts) != nil {
					return
				}
				_, _ = emit(ctx, session.MessageSent, model.Message{Role: model.User, Parts: input.Parts}, input.Cause)
			}
		}
	}()
	scanner := bufio.NewScanner(stdout)
	scanner.Buffer(make([]byte, 64<<10), 4<<20)
	for scanner.Scan() {
		var raw struct {
			SessionID string `json:"session_id"`
			Message   struct {
				ID string `json:"id"`
			} `json:"message"`
			Type       string          `json:"type"`
			Subtype    string          `json:"subtype"`
			Result     string          `json:"result"`
			IsError    bool            `json:"is_error"`
			Structured json.RawMessage `json:"structured_output"`
			Queued     int             `json:"queued_turn_count"`
		}
		if err := json.Unmarshal(scanner.Bytes(), &raw); err != nil {
			runErr = err
			break
		}
		if raw.Type == "system" && raw.Subtype == "init" && raw.SessionID != "" {
			if err := r.saveSession(ctx, a, raw.SessionID, previous); err != nil {
				runErr = err
				break
			}
		}
		if raw.Type == "result" {
			if raw.Result != "" {
				last = raw.Result
			}
			if len(raw.Structured) > 0 && string(raw.Structured) != "null" {
				last = string(raw.Structured)
			}
			if raw.IsError || raw.Subtype != "success" {
				runErr = errors.New("external worker did not complete its task")
			}
			if raw.Queued == 0 {
				stopWriter()
				_ = stdin.Close()
			}
			continue
		}
		facts, err := Translate(scanner.Bytes(), scope, actor)
		if err != nil {
			runErr = err
			break
		}
		for _, fact := range facts {
			if fact.Type == session.MessageCompleted && raw.Message.ID != "" {
				completion, _ := event.Decode[session.Completion](fact)
				previous, current := usages[raw.Message.ID], completion.Usage
				completion.Usage = model.Usage{Input: max(0, current.Input-previous.Input), Output: max(0, current.Output-previous.Output), CacheRead: max(0, current.CacheRead-previous.CacheRead), CacheWrite: max(0, current.CacheWrite-previous.CacheWrite)}
				usages[raw.Message.ID] = previous.Add(completion.Usage)
				fact.Payload, _ = json.Marshal(completion)
			}
			if fact.Type == tool.Completed {
				completion, _ := event.Decode[tool.Completion](fact)
				origin := called[completion.CallID]
				call, _ := event.Decode[model.ToolCall](origin)
				completion.Name = call.Name
				fact.Cause = origin.ID
				fact.Payload, _ = json.Marshal(completion)
				delete(called, completion.CallID)
			}
			persisted, err := r.Bus.Publish(ctx, fact)
			if err != nil {
				runErr = err
				break
			}
			if fact.Type == session.MessageCompleted {
				completion, _ := event.Decode[session.Completion](fact)
				usage = usage.Add(completion.Usage)
			}
			if fact.Type == tool.Called {
				call, _ := event.Decode[model.ToolCall](fact)
				called[call.ID] = persisted
				order = append(order, call.ID)
			}
			if fact.Type == session.MessageCompleted {
				message, _ := event.Decode[session.Completion](fact)
				var text strings.Builder
				for _, part := range message.Parts {
					text.WriteString(part.Text)
				}
				if text.Len() > 0 {
					last = text.String()
				}
			}
		}
		if runErr != nil {
			break
		}
	}
	if err := scanner.Err(); err != nil {
		runErr = err
	}
	if runErr != nil {
		_ = cmd.Cancel()
	}
	err = cmd.Wait()
	stopWriter()
	_ = stdin.Close()
	<-writerDone
	if runErr == nil {
		runErr = err
	}
	return report, runErr
}
