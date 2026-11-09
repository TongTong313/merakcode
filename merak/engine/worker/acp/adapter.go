// Package acp runs agents implementing version one of Agent Client Protocol.
package acp

import (
	"context"
	"encoding/json"
	"errors"
	"github.com/TongTong313/merakcode/merak/engine/event"
	"github.com/TongTong313/merakcode/merak/engine/loop"
	"github.com/TongTong313/merakcode/merak/engine/model"
	"github.com/TongTong313/merakcode/merak/engine/permission"
	"github.com/TongTong313/merakcode/merak/engine/profile"
	"github.com/TongTong313/merakcode/merak/engine/store"
	"github.com/TongTong313/merakcode/merak/engine/task"
	"github.com/TongTong313/merakcode/merak/engine/worker"
	"github.com/TongTong313/merakcode/merak/engine/worker/internal/stdio"
	"github.com/TongTong313/merakcode/merak/internal/platform/sandbox"
	"io"
	"os"
	"strconv"
)

type Runner struct {
	Sandbox *sandbox.Launcher
	Store   store.Store
	Bus     *event.Bus
	Gate    *permission.Gate
	Product profile.Product
	System  string
}

func (*Runner) Caps() worker.Caps { return worker.Caps{Permission: true} }

type run struct{ worker.Run }

func (run) Send(context.Context, loop.Input) error { return worker.ErrUnsupported }
func (r *Runner) Start(ctx context.Context, a worker.Assignment) (worker.Run, error) {
	if a.ReadOnly && r.Product.Kind != worker.KindOpenCode {
		return nil, errors.New("generic ACP does not guarantee read-only tools")
	}
	result, err := worker.Launch(ctx, r.Bus, a, func(ctx context.Context, _ <-chan loop.Input) (task.Report, error) { return r.execute(ctx, a) })
	if err != nil {
		return nil, err
	}
	return run{result}, nil
}

type wire struct {
	ID             json.RawMessage
	Method         string
	Params, Result json.RawMessage
	Error          *struct{ Code int }
}

func (r *Runner) execute(ctx context.Context, a worker.Assignment) (report task.Report, runErr error) {
	name := string(r.Product.Kind)
	if name == "" {
		name = "acp"
	}
	j, err := stdio.NewJournal(ctx, r.Bus, r.Store, a, name, r.Product.Model)
	if err != nil {
		return report, err
	}
	defer func() { report, runErr = j.Finish(ctx, runErr) }()
	previous, err := stdio.LoadSession(ctx, r.Store, a, name)
	if err != nil {
		return report, err
	}
	child, err := stdio.Start(ctx, a, r.Product, r.Product.Args, r.Sandbox)
	if err != nil {
		return report, err
	}
	defer child.Close()
	pending := map[string]string{}
	sequence := 0
	request := func(method string, params any) error {
		sequence++
		id := strconv.Itoa(sequence)
		pending[`"`+id+`"`] = method
		return child.Write(map[string]any{"jsonrpc": "2.0", "id": id, "method": method, "params": params})
	}
	if err := request("initialize", map[string]any{"protocolVersion": 1, "clientCapabilities": map[string]any{}, "clientInfo": map[string]string{"name": "merakcode", "version": "1.0.0"}}); err != nil {
		return report, err
	}
	id := ""
	state := translation{journal: j, calls: map[string]update{}}
	for {
		select {
		case <-ctx.Done():
			return report, ctx.Err()
		case line, ok := <-child.Lines:
			if !ok {
				if err := child.Err(); err != nil {
					return report, err
				}
				return report, io.ErrUnexpectedEOF
			}
			var m wire
			if err := json.Unmarshal(line, &m); err != nil {
				return report, err
			}
			if m.Method == "" {
				method := pending[string(m.ID)]
				delete(pending, string(m.ID))
				if m.Error != nil {
					return report, errors.New("ACP agent rejected a request")
				}
				switch method {
				case "initialize":
					var result struct {
						ProtocolVersion   int
						AgentCapabilities struct{ LoadSession bool }
					}
					if err := json.Unmarshal(m.Result, &result); err != nil {
						return report, err
					}
					if result.ProtocolVersion != 1 {
						return report, errors.New("ACP protocol version is not supported")
					}
					cwd := a.Workdir
					if cwd == "" {
						cwd, _ = os.Getwd()
					}
					method := "session/new"
					params := map[string]any{"cwd": cwd, "mcpServers": []any{}}
					if previous != "" {
						if !result.AgentCapabilities.LoadSession {
							return report, errors.New("ACP agent cannot reload the existing session")
						}
						id = previous
						method = "session/load"
						params["sessionId"] = id
					}
					if err := request(method, params); err != nil {
						return report, err
					}
				case "session/new", "session/load":
					var result struct{ SessionID string }
					if err := json.Unmarshal(m.Result, &result); err != nil {
						return report, err
					}
					if method == "session/new" {
						id = result.SessionID
					}
					if id == "" {
						return report, errors.New("ACP agent did not create a session")
					}
					if err := stdio.SaveSession(ctx, r.Store, a, name, id); err != nil {
						return report, err
					}
					text := a.Packet
					if r.System != "" {
						text = r.System + "\n\n" + text
					}
					if err := request("session/prompt", map[string]any{"sessionId": id, "prompt": []map[string]string{{"type": "text", "text": text}}}); err != nil {
						return report, err
					}
					if err := j.Input(ctx, loop.Input{Parts: []model.Part{{Text: a.Packet}}, Cause: a.Cause}); err != nil {
						return report, err
					}
				case "session/prompt":
					if err := state.flush(ctx); err != nil {
						return report, err
					}
					var result struct{ StopReason string }
					if err := json.Unmarshal(m.Result, &result); err != nil {
						return report, err
					}
					if result.StopReason == "cancelled" {
						return report, context.Canceled
					}
					if result.StopReason != "end_turn" {
						return report, errors.New("ACP agent stopped before completing its response")
					}
					return report, nil
				}
				continue
			}
			var params struct {
				SessionID string
				Update    update
			}
			if err := json.Unmarshal(m.Params, &params); err != nil {
				return report, err
			}
			if params.SessionID != id {
				return report, errors.New("ACP event does not belong to the assignment")
			}
			if m.Method == "session/request_permission" && len(m.ID) > 0 {
				result, err := state.approve(ctx, r.Gate, m.Params)
				if err != nil {
					return report, err
				}
				if err := child.Write(map[string]any{"jsonrpc": "2.0", "id": m.ID, "result": result}); err != nil {
					return report, err
				}
				continue
			}
			if len(m.ID) > 0 {
				if err := child.Write(map[string]any{"jsonrpc": "2.0", "id": m.ID, "error": map[string]any{"code": -32601, "message": "Client capability is not supported"}}); err != nil {
					return report, err
				}
				continue
			}
			if m.Method == "session/update" {
				loading := false
				for _, method := range pending {
					if method == "session/load" {
						loading = true
						break
					}
				}
				if loading {
					continue
				}
				if err := state.apply(ctx, params.Update); err != nil {
					return report, err
				}
			}
		}
	}
}
