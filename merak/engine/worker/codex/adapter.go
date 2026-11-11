// Package codex runs the Codex app-server JSON-RPC protocol over stdio.
package codex

import (
	"context"
	"encoding/json"
	"errors"
	"github.com/TongTong313/merakcode/merak/engine/agent"
	"github.com/TongTong313/merakcode/merak/engine/event"
	"github.com/TongTong313/merakcode/merak/engine/loop"
	"github.com/TongTong313/merakcode/merak/engine/model"
	"github.com/TongTong313/merakcode/merak/engine/permission"
	"github.com/TongTong313/merakcode/merak/engine/session"
	"github.com/TongTong313/merakcode/merak/engine/store"
	"github.com/TongTong313/merakcode/merak/engine/task"
	"github.com/TongTong313/merakcode/merak/engine/worker"
	"github.com/TongTong313/merakcode/merak/engine/worker/internal/stdio"
	"github.com/TongTong313/merakcode/merak/internal/platform/sandbox"
	"io"
	"os"
	"strconv"
	"strings"
)

type Runner struct {
	Sandbox *sandbox.Launcher
	Store   store.Store
	Bus     *event.Bus
	Gate    *permission.Gate
	Product agent.Product
	System  string
}

func (*Runner) Caps() worker.Caps { return worker.Caps{Steer: true, Permission: true, MCP: true} }
func (r *Runner) Start(ctx context.Context, a worker.Assignment) (worker.Run, error) {
	return worker.Launch(ctx, r.Bus, a, func(ctx context.Context, inputs <-chan loop.Input) (task.Report, error) {
		return r.execute(ctx, a, inputs)
	})
}

type wire struct {
	ID             json.RawMessage
	Method         string
	Params, Result json.RawMessage
	Error          *struct {
		Code    int
		Message string
	}
}

func (r *Runner) execute(ctx context.Context, a worker.Assignment, inputs <-chan loop.Input) (report task.Report, runErr error) {
	j, err := stdio.NewJournal(ctx, r.Bus, r.Store, a, "codex", r.Product.Model)
	if err != nil {
		return report, err
	}
	defer func() { report, runErr = j.Finish(ctx, runErr) }()
	previous, err := stdio.LoadSession(ctx, r.Store, a, "codex")
	if err != nil {
		return report, err
	}
	var nativeUsage model.Usage
	if previous != "" && r.Store != nil {
		state, err := session.NewManager(r.Store, r.Bus).Load(ctx, a.Session)
		if err != nil {
			return report, err
		}
		nativeUsage = state.Usage
	}
	packet := a.Packet
	var recovered []event.ID
	if a.Leader {
		packet, recovered, err = worker.RecoverInput(ctx, r.Store, a.Session, previous == "", j.Previous, a.Packet)
		if err != nil {
			return report, err
		}
	}
	p := r.Product
	if p.Binary == "" {
		p.Binary = "codex"
	}
	args := append([]string(nil), p.Args...)
	if len(args) == 0 || args[0] != "app-server" {
		args = append([]string{"app-server"}, args...)
	}
	for _, setting := range []string{"analytics.enabled=false", "feedback.enabled=false", "check_for_update_on_startup=false", `otel.exporter="none"`, `otel.trace_exporter="none"`, `otel.metrics_exporter="none"`} {
		args = append(args, "-c", setting)
	}
	if a.MCP != nil {
		command, _ := json.Marshal(a.MCP.Command)
		arguments, _ := json.Marshal(a.MCP.Args)
		args = append(args, "-c", "mcp_servers.merak.command="+string(command), "-c", "mcp_servers.merak.args="+string(arguments))
		for name, value := range a.MCP.Env {
			key, _ := json.Marshal(name)
			literal, _ := json.Marshal(value)
			args = append(args, "-c", "mcp_servers.merak.env."+string(key)+"="+string(literal))
		}
	}
	if r.Sandbox != nil && !r.Sandbox.Disabled {
		a.SandboxProfile, err = stdio.ProductState(a.SandboxProfile, ".codex")
		if err != nil {
			return report, err
		}
	}
	j.Sandbox, j.Assignment = r.Sandbox, a
	child, err := stdio.Start(ctx, a, p, args, r.Sandbox)
	if err != nil {
		return report, err
	}
	defer func() { runErr = errors.Join(runErr, child.Close()) }()
	pending := map[string]string{}
	sequence := 0
	request := func(method string, params any) error {
		sequence++
		id := strconv.Itoa(sequence)
		pending[`"`+id+`"`] = method
		return child.Write(map[string]any{"id": id, "method": method, "params": params})
	}
	if err := request("initialize", map[string]any{"clientInfo": map[string]string{"name": "merakcode", "title": "MerakCode", "version": "1.0.0"}}); err != nil {
		return report, err
	}
	thread, turn := "", ""
	starting := false
	waitingCompletion := false
	type delivery struct {
		input  loop.Input
		logged bool
		ids    []event.ID
		text   string
		turn   string
	}
	var startedDelivery delivery
	var queued []delivery
	steers := make(map[string]delivery)
	send := func(item delivery, steer bool) error {
		in := item.input
		params := map[string]any{"threadId": thread, "input": []map[string]string{{"type": "text", "text": stdio.Text(in.Parts)}}}
		if item.text != "" {
			params["input"] = []map[string]string{{"type": "text", "text": item.text}}
		}
		method := "turn/start"
		if steer {
			method = "turn/steer"
			params["expectedTurnId"] = turn
		}
		if !steer {
			starting = true
		}
		if err := j.BeginTurn(ctx, in.Cause); err != nil {
			return err
		}
		if !item.logged {
			id, err := j.RecordInput(ctx, in)
			if err != nil {
				return err
			}
			item.ids = append(item.ids, id)
			item.logged = true
		}
		if err := request(method, params); err != nil {
			return err
		}
		if steer {
			item.turn = turn
			steers[`"`+strconv.Itoa(sequence)+`"`] = item
		} else {
			startedDelivery = item
		}
		return nil
	}
	flush := func() error {
		if thread == "" || starting || waitingCompletion || a.LeaderTurn.Finishing() || len(steers) > 0 || len(queued) == 0 {
			return nil
		}
		item := queued[0]
		queued = queued[1:]
		return send(item, turn != "")
	}
	endIfIdle := func() error {
		if a.Leader && thread != "" && turn == "" && !starting && len(steers) == 0 && len(queued) == 0 {
			return j.EndTurn(ctx)
		}
		return nil
	}
	for {
		select {
		case <-ctx.Done():
			return report, ctx.Err()
		case in := <-inputs:
			queued = append(queued, delivery{input: in})
			if err := flush(); err != nil {
				return report, err
			}
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
				item, steered := steers[string(m.ID)]
				delete(steers, string(m.ID))
				if m.Error != nil {
					if steered && m.Error.Code == -32600 && strings.EqualFold(m.Error.Message, "no active turn to steer") {
						waitingCompletion = turn != ""
						queued = append([]delivery{item}, queued...)
						if turn == "" {
							if err := flush(); err != nil {
								return report, err
							}
						}
						continue
					}
					return report, errors.New("codex rejected a request")
				}
				switch method {
				case "initialize":
					if err := child.Write(map[string]any{"method": "initialized"}); err != nil {
						return report, err
					}
					cwd := a.Workdir
					if cwd == "" {
						cwd, _ = os.Getwd()
					}
					sandbox := "workspace-write"
					approval := "untrusted"
					if a.Mode == permission.ModeTakeover {
						sandbox, approval = "danger-full-access", "never"
					}
					if a.ReadOnly {
						sandbox = "read-only"
					}
					params := map[string]any{"cwd": cwd, "approvalPolicy": approval, "approvalsReviewer": "user", "sandbox": sandbox, "developerInstructions": r.System}
					if p.Model != "" {
						params["model"] = p.Model
					}
					method := "thread/start"
					if previous != "" {
						method = "thread/resume"
						params["threadId"] = previous
					}
					if err := request(method, params); err != nil {
						return report, err
					}
				case "thread/start", "thread/resume":
					var result struct{ Thread struct{ ID string } }
					if err := json.Unmarshal(m.Result, &result); err != nil {
						return report, err
					}
					thread = result.Thread.ID
					if thread == "" {
						return report, errors.New("codex did not create a thread")
					}
					if err := stdio.SaveSession(ctx, r.Store, a, "codex", thread); err != nil {
						return report, err
					}
					if err := send(delivery{input: loop.Input{Parts: []model.Part{{Text: a.Packet}}, Cause: a.Cause}, text: packet, ids: recovered}, false); err != nil {
						return report, err
					}
				case "turn/start":
					var result struct{ Turn struct{ ID string } }
					if err := json.Unmarshal(m.Result, &result); err != nil {
						return report, err
					}
					turn = result.Turn.ID
					starting = false
					if turn == "" {
						return report, errors.New("codex did not start a turn")
					}
					if a.Leader {
						if err := worker.AcknowledgeInputs(ctx, r.Store, a.Session, startedDelivery.ids); err != nil {
							return report, err
						}
					}
				case "turn/steer":
					var result struct {
						TurnID string `json:"turnId"`
					}
					if err := json.Unmarshal(m.Result, &result); err != nil || !steered || result.TurnID != item.turn {
						return report, errors.New("codex acknowledged a different turn")
					}
					if a.Leader {
						if err := worker.AcknowledgeInputs(ctx, r.Store, a.Session, item.ids); err != nil {
							return report, err
						}
					}
				}
				if err := flush(); err != nil {
					return report, err
				}
				if err := endIfIdle(); err != nil {
					return report, err
				}
				continue
			}
			var scope struct {
				ThreadID, TurnID string
				Turn             struct{ ID, Status string }
			}
			if err := json.Unmarshal(m.Params, &scope); err != nil {
				return report, err
			}
			if scope.ThreadID != "" && scope.ThreadID != thread || scope.TurnID != "" && turn != "" && scope.TurnID != turn {
				return report, errors.New("codex event does not belong to the assignment")
			}
			if len(m.ID) > 0 {
				result, err := r.approve(ctx, j, m)
				if err != nil {
					return report, err
				}
				if err := child.Write(map[string]any{"id": m.ID, "result": result}); err != nil {
					return report, err
				}
				continue
			}
			if m.Method == "turn/completed" {
				if scope.Turn.ID != turn {
					return report, errors.New("codex completed an unexpected turn")
				}
				if scope.Turn.Status == "interrupted" {
					return report, context.Canceled
				}
				if scope.Turn.Status != "completed" {
					return report, errors.New("codex turn failed")
				}
				if a.Leader {
					turn = ""
					waitingCompletion = false
					if a.LeaderTurn.Finishing() {
						// Reopen orchestration for accepted inputs before settling the batch.
						a.LeaderTurn.End()
					}
					if err := flush(); err != nil {
						return report, err
					}
					if err := endIfIdle(); err != nil {
						return report, err
					}
					continue
				}
				return report, nil
			}
			if err := translate(ctx, j, m.Method, m.Params, &nativeUsage); err != nil {
				return report, err
			}
		}
	}
}
