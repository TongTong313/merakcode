// Package codex runs the Codex app-server JSON-RPC protocol over stdio.
package codex

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
	"io"
	"os"
	"strconv"
)

type Runner struct {
	Store   store.Store
	Bus     *event.Bus
	Gate    *permission.Gate
	Product profile.Product
	System  string
}

func (*Runner) Caps() worker.Caps { return worker.Caps{Steer: true, Permission: true} }
func (r *Runner) Start(ctx context.Context, a worker.Assignment) (worker.Run, error) {
	return worker.Launch(ctx, r.Bus, a, func(ctx context.Context, inputs <-chan loop.Input) (task.Report, error) {
		return r.execute(ctx, a, inputs)
	})
}

type wire struct {
	ID             json.RawMessage
	Method         string
	Params, Result json.RawMessage
	Error          *struct{ Code int }
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
	p := r.Product
	if p.Binary == "" {
		p.Binary = "codex"
	}
	args := append([]string(nil), p.Args...)
	if len(args) == 0 || args[0] != "app-server" {
		args = append([]string{"app-server"}, args...)
	}
	child, err := stdio.Start(ctx, a.Workdir, p, args)
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
		return child.Write(map[string]any{"id": id, "method": method, "params": params})
	}
	if err := request("initialize", map[string]any{"clientInfo": map[string]string{"name": "merakcode", "title": "MerakCode", "version": "1.0.0"}}); err != nil {
		return report, err
	}
	thread, turn := "", ""
	var queued []loop.Input
	send := func(in loop.Input, steer bool) error {
		params := map[string]any{"threadId": thread, "input": []map[string]string{{"type": "text", "text": stdio.Text(in.Parts)}}}
		method := "turn/start"
		if steer {
			method = "turn/steer"
			params["expectedTurnId"] = turn
		}
		if err := request(method, params); err != nil {
			return err
		}
		return j.Input(ctx, in)
	}
	for {
		select {
		case <-ctx.Done():
			return report, ctx.Err()
		case in := <-inputs:
			if turn == "" {
				queued = append(queued, in)
			} else if err := send(in, true); err != nil {
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
				if m.Error != nil {
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
					if a.ReadOnly {
						sandbox = "read-only"
					}
					params := map[string]any{"cwd": cwd, "approvalPolicy": "untrusted", "approvalsReviewer": "user", "sandbox": sandbox, "developerInstructions": r.System}
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
					if err := send(loop.Input{Parts: []model.Part{{Text: a.Packet}}, Cause: a.Cause}, false); err != nil {
						return report, err
					}
				case "turn/start":
					var result struct{ Turn struct{ ID string } }
					if err := json.Unmarshal(m.Result, &result); err != nil {
						return report, err
					}
					turn = result.Turn.ID
					if turn == "" {
						return report, errors.New("codex did not start a turn")
					}
					for _, in := range queued {
						if err := send(in, true); err != nil {
							return report, err
						}
					}
					queued = nil
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
				return report, nil
			}
			if err := translate(ctx, j, m.Method, m.Params); err != nil {
				return report, err
			}
		}
	}
}
