package claudecode

import (
	"bufio"
	"context"
	"crypto/rand"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os/exec"
	"strings"
	"sync"
	"time"

	"github.com/TongTong313/merakcode/merak/engine/event"
	"github.com/TongTong313/merakcode/merak/engine/loop"
	"github.com/TongTong313/merakcode/merak/engine/model"
	"github.com/TongTong313/merakcode/merak/engine/permission"
	"github.com/TongTong313/merakcode/merak/engine/profile"
	"github.com/TongTong313/merakcode/merak/engine/session"
	"github.com/TongTong313/merakcode/merak/engine/store"
	"github.com/TongTong313/merakcode/merak/engine/task"
	"github.com/TongTong313/merakcode/merak/engine/tool"
	"github.com/TongTong313/merakcode/merak/engine/worker"
	"github.com/TongTong313/merakcode/merak/engine/worker/internal/stdio"
	"github.com/TongTong313/merakcode/merak/internal/platform/process"
	"github.com/TongTong313/merakcode/merak/internal/platform/sandbox"
)

type Runner struct {
	Sandbox *sandbox.Launcher
	Bus     *event.Bus
	Store   store.Store
	Gate    *permission.Gate
	Product profile.Product
	System  string
}

func (*Runner) Caps() worker.Caps { return worker.Caps{Steer: true, Permission: true, MCP: true} }
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
	var scopeMu sync.RWMutex
	currentScope := func() event.Scope { scopeMu.RLock(); defer scopeMu.RUnlock(); return scope }
	actor := event.Actor{Kind: event.ActorAgent, ID: a.Claim.Member}
	emit := func(ctx context.Context, kind event.Type, payload any, cause event.ID) (event.Event, error) {
		body, err := json.Marshal(payload)
		if err != nil {
			return event.Event{}, err
		}
		return r.Bus.Publish(ctx, event.Event{Stream: event.Stream("session:" + a.Session), Type: kind, Scope: currentScope(), Actor: actor, Cause: cause, Payload: body})
	}
	state := session.State{ID: a.Session, Scope: scope, Config: session.Config{Provider: "claude-code", Model: r.Product.Model, Workdir: a.Workdir, Mode: a.Mode, Member: a.Claim.Member}}
	state.Config.ToolPool = "worker.default"
	if a.ReadOnly {
		state.Config.ToolPool = "worker.readonly"
	}
	if a.Leader {
		state.Config.ToolPool = "leader.default"
	}
	created := false
	var history []model.Message
	if r.Store != nil {
		saved, err := session.NewManager(r.Store, r.Bus).Load(ctx, a.Session)
		if err != nil && !errors.Is(err, store.ErrNotFound) {
			return report, err
		}
		created = err == nil
		if created {
			history = saved.Messages
		}
		if created && (saved.Config.Provider != "claude-code" || saved.Config.Member != a.Claim.Member || saved.Config.Workdir != a.Workdir || saved.Scope.Group != a.Scope.Group || saved.Scope.Task != a.Scope.Task) {
			return report, errors.New("assignment does not match the existing session")
		}
	}
	if !created {
		if _, err := emit(ctx, session.Created, state, ""); err != nil {
			return report, err
		}
	}
	started, err := emit(ctx, loop.TurnStarted, session.Started{}, "")
	if err != nil {
		return report, err
	}
	scope.Turn = started.ID
	a.LeaderTurn.Begin()
	defer a.LeaderTurn.End()
	last := ""
	stop := loop.Answered
	called := map[string]event.Event{}
	usages := map[string]model.Usage{}
	var usage model.Usage
	var turnUsage model.Usage
	var turnMu sync.Mutex
	pendingInputs := make(map[string][]event.ID)
	inputSlots := make(chan struct{}, 64)
	var order []string
	defer func() {
		stop, runErr = worker.Termination(ctx, runErr, stop)
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
		var err error
		if !a.Leader || currentScope().Turn != "" {
			_, err = emit(ending, loop.TurnFinished, loop.Outcome{Stop: stop, Final: []model.Part{{Text: last}}, Usage: turnUsage}, "")
		}
		if runErr == nil {
			runErr = err
		}
	}()
	packet := a.Packet
	var recovered []event.ID
	if a.Leader {
		packet, recovered, err = worker.RecoverInput(ctx, r.Store, a.Session, previous.Product == "", history, a.Packet)
		if err != nil {
			return report, err
		}
	}
	initial, err := emit(ctx, session.MessageSent, session.Input{Message: model.Message{Role: model.User, Parts: []model.Part{{Text: a.Packet}}}, Sources: a.Sources}, a.Cause)
	if err != nil {
		return report, err
	}
	recovered = append(recovered, initial.ID)
	args := append([]string{"-p", "--output-format", "stream-json", "--input-format", "stream-json", "--verbose", "--include-partial-messages"}, r.Product.Args...)
	args = append(args, "--permission-prompt-tool", "stdio", "--permission-mode", "default", "--settings", `{"permissions":{"ask":["*"]},"sandbox":{"autoAllowBashIfSandboxed":false}}`)
	if a.MCP != nil {
		config, _ := json.Marshal(map[string]any{"mcpServers": map[string]any{"merak": a.MCP}})
		args = append(args, "--mcp-config", string(config))
	}
	if a.ReadOnly {
		args = append(args, "--tools", "Read,Grep,Glob")
	}
	if previous.Product != "" {
		args = append(args, "--resume", previous.Product)
	}
	reportInstruction := "At the end, return a JSON object with verdict (done, blocked, needs_review, or failed) and summary (at most 1200 characters)."
	if a.MCP != nil {
		reportInstruction = "Submit the final task report with the merak MCP submit_report tool."
	}
	if a.Leader {
		reportInstruction = "Use the merak MCP tools to coordinate this thread. Remain available for later event messages."
	}
	args = append(args, "--append-system-prompt", strings.TrimSpace(r.System+"\n"+reportInstruction))
	if r.Product.Model != "" {
		args = append(args, "--model", r.Product.Model)
	}
	a.SandboxProfile.EnvAllow = append(append([]string(nil), a.SandboxProfile.EnvAllow...), "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC")
	var configDirectory string
	if r.Sandbox != nil && !r.Sandbox.Disabled {
		a.SandboxProfile, configDirectory, err = stdio.ClaudeState(a.SandboxProfile, r.Product.Env["CLAUDE_CONFIG_DIR"])
		if err != nil {
			return report, err
		}
	}
	cmd := process.Command(ctx, a.Workdir, binary, args...)
	if r.Sandbox != nil {
		cmd, err = r.Sandbox.Command(ctx, a.SandboxProfile, binary, args...)
		if err != nil {
			return report, err
		}
		cmd.Dir = a.Workdir
	}
	cmd.Env = cmd.Environ()
	for key, value := range r.Product.Env {
		cmd.Env = append(cmd.Env, key+"="+value)
	}
	cmd.Env = append(cmd.Env, "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1")
	if configDirectory != "" {
		cmd.Env = append(cmd.Env, "CLAUDE_CONFIG_DIR="+configDirectory)
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
	if err := r.Sandbox.Start(cmd, a.SandboxProfile); err != nil {
		return report, err
	}
	var writeMu sync.Mutex
	writeControl := func(value any) error {
		writeMu.Lock()
		defer writeMu.Unlock()
		return json.NewEncoder(stdin).Encode(value)
	}
	write := func(writeCtx context.Context, input loop.Input, record bool) error {
		parts, cause := input.Parts, input.Cause
		if a.Leader {
			select {
			case inputSlots <- struct{}{}:
			case <-writeCtx.Done():
				return writeCtx.Err()
			}
		}
		turnMu.Lock()
		defer turnMu.Unlock()
		if a.Leader && currentScope().Turn == "" {
			started, err := emit(ctx, loop.TurnStarted, session.Started{}, "")
			if err != nil {
				return err
			}
			scopeMu.Lock()
			scope.Turn = started.ID
			scopeMu.Unlock()
			a.LeaderTurn.Begin()
		}
		var text strings.Builder
		for _, part := range parts {
			text.WriteString(part.Text)
		}
		ids := recovered
		if record {
			fact, err := emit(ctx, session.MessageSent, session.Input{Message: model.Message{Role: model.User, Parts: parts}, Sources: input.Sources}, cause)
			if err != nil {
				return err
			}
			ids = []event.ID{fact.ID}
		}
		var id [16]byte
		if _, err := rand.Read(id[:]); err != nil {
			return err
		}
		id[6], id[8] = id[6]&0x0f|0x40, id[8]&0x3f|0x80
		uuid := fmt.Sprintf("%x-%x-%x-%x-%x", id[:4], id[4:6], id[6:8], id[8:10], id[10:])
		if a.Leader {
			pendingInputs[uuid] = ids
		}
		return writeControl(map[string]any{"type": "user", "uuid": uuid, "message": map[string]any{"role": "user", "content": text.String()}, "parent_tool_use_id": nil})
	}
	if err := writeControl(map[string]any{"type": "control_request", "request_id": "merak-initialize", "request": map[string]any{"subtype": "initialize", "hooks": nil}}); err != nil {
		_ = cmd.Process.Kill()
		return report, errors.Join(err, r.Sandbox.Wait(cmd))
	}
	writerCtx, stopWriter := context.WithCancel(ctx)
	defer stopWriter()
	writerDone := make(chan struct{})
	initialized := make(chan struct{})
	go func() {
		defer close(writerDone)
		select {
		case <-writerCtx.Done():
			return
		case <-initialized:
		}
		for {
			select {
			case <-writerCtx.Done():
				return
			case input := <-inputs:
				if a.LeaderTurn.WaitInput(writerCtx) != nil {
					return
				}
				if write(writerCtx, input, true) != nil {
					_ = cmd.Process.Kill()
					return
				}
			}
		}
	}()
	scanner := bufio.NewScanner(stdout)
	scanner.Buffer(make([]byte, 64<<10), 4<<20)
	journal := &stdio.Journal{Bus: r.Bus, Assignment: a, Scope: scope, Sandbox: r.Sandbox}
	ready := false
	for scanner.Scan() {
		var raw struct {
			RequestID string         `json:"request_id"`
			Request   controlRequest `json:"request"`
			Response  struct {
				RequestID string `json:"request_id"`
				Subtype   string `json:"subtype"`
			} `json:"response"`
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
			Inputs     []string        `json:"user_message_uuids"`
		}
		if err := json.Unmarshal(scanner.Bytes(), &raw); err != nil {
			runErr = err
			break
		}
		if raw.Type == "control_response" {
			if ready || raw.Response.RequestID != "merak-initialize" || raw.Response.Subtype != "success" {
				runErr = errors.New("external worker initialization failed")
				break
			}
			if runErr = write(ctx, loop.Input{Parts: []model.Part{{Text: packet}}, Cause: a.Cause}, false); runErr != nil {
				break
			}
			ready = true
			close(initialized)
			continue
		}
		if raw.Type == "control_request" {
			journal.Scope = currentScope()
			runErr = r.respondPermission(ctx, journal, raw.RequestID, raw.Request, writeControl)
			if runErr != nil {
				break
			}
			continue
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
				break
			}
			if a.Leader {
				turnMu.Lock()
				if len(raw.Inputs) == 0 {
					turnMu.Unlock()
					runErr = errors.New("external leader result omitted input acknowledgements")
					break
				}
				for _, id := range raw.Inputs {
					if ids, ok := pendingInputs[id]; ok {
						if runErr = worker.AcknowledgeInputs(ctx, r.Store, a.Session, ids); runErr != nil {
							break
						}
						delete(pendingInputs, id)
						<-inputSlots
					}
				}
				if runErr != nil {
					turnMu.Unlock()
					break
				}
				if len(pendingInputs) != 0 && !a.LeaderTurn.Finishing() {
					turnMu.Unlock()
					continue
				}
				_, runErr = emit(ctx, loop.TurnFinished, loop.Outcome{Stop: stop, Final: []model.Part{{Text: last}}, Usage: turnUsage}, "")
				turnUsage = model.Usage{}
				scopeMu.Lock()
				scope.Turn = ""
				scopeMu.Unlock()
				a.LeaderTurn.End()
				turnMu.Unlock()
				if runErr != nil {
					break
				}
				continue
			}
			if raw.Queued == 0 {
				stopWriter()
				_ = stdin.Close()
			}
			continue
		}
		if a.Leader && (raw.Type == "assistant" || raw.Type == "stream_event") {
			turnMu.Lock()
			if currentScope().Turn == "" && len(pendingInputs) > 0 {
				started, err := emit(ctx, loop.TurnStarted, session.Started{}, "")
				if err != nil {
					turnMu.Unlock()
					runErr = err
					break
				}
				scopeMu.Lock()
				scope.Turn = started.ID
				scopeMu.Unlock()
				a.LeaderTurn.Begin()
			}
			turnMu.Unlock()
		}
		facts, err := Translate(scanner.Bytes(), currentScope(), actor)
		if err != nil {
			runErr = err
			break
		}
		for _, fact := range facts {
			if fact.Type == session.MessageCompleted && raw.Message.ID != "" {
				completion, _ := event.Decode[session.Completion](fact)
				_, repeated := usages[raw.Message.ID]
				completion.Step = new(!repeated)
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
				turnUsage = turnUsage.Add(completion.Usage)
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
	err = r.Sandbox.Wait(cmd)
	stopWriter()
	_ = stdin.Close()
	<-writerDone
	runErr = errors.Join(runErr, err)
	return report, runErr
}
