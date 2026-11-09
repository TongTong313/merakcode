package stdio

import (
	"context"
	"encoding/json"
	"errors"
	"github.com/TongTong313/merakcode/merak/engine/event"
	"github.com/TongTong313/merakcode/merak/engine/loop"
	"github.com/TongTong313/merakcode/merak/engine/model"
	"github.com/TongTong313/merakcode/merak/engine/session"
	"github.com/TongTong313/merakcode/merak/engine/store"
	"github.com/TongTong313/merakcode/merak/engine/task"
	"github.com/TongTong313/merakcode/merak/engine/tool"
	"github.com/TongTong313/merakcode/merak/engine/worker"
	"time"
)

type Journal struct {
	Bus        *event.Bus
	Assignment worker.Assignment
	Scope      event.Scope
	Last       string
	usage      model.Usage
	Previous   []model.Message
	partial    string
	calls      map[string]event.Event
	order      []string
}

func NewJournal(ctx context.Context, bus *event.Bus, storage store.Store, a worker.Assignment, provider, modelName string) (*Journal, error) {
	j := &Journal{Bus: bus, Assignment: a, Scope: a.Scope, calls: map[string]event.Event{}}
	j.Scope.Session = a.Session
	created := false
	if storage != nil {
		state, err := session.NewManager(storage, bus).Load(ctx, a.Session)
		if err != nil && !errors.Is(err, store.ErrNotFound) {
			return nil, err
		}
		if err == nil {
			if state.Config.Provider != provider || state.Config.Member != a.Claim.Member || state.Config.Workdir != a.Workdir || state.Scope.Group != a.Scope.Group || state.Scope.Task != a.Scope.Task {
				return nil, errors.New("assignment does not match the existing session")
			}
			j.Previous = state.Messages
			created = true
		}
	}
	if !created {
		if _, err := j.Emit(ctx, session.Created, session.State{ID: a.Session, Scope: j.Scope, Config: session.Config{Provider: provider, Model: modelName, Workdir: a.Workdir, Member: a.Claim.Member, Mode: a.Mode}}, ""); err != nil {
			return nil, err
		}
	}
	start, err := j.Emit(ctx, loop.TurnStarted, session.Started{}, "")
	if err != nil {
		return nil, err
	}
	j.Scope.Turn = start.ID
	return j, nil
}

// ReplayPrompt retains the engine conversation when a product has no session loader.
func (j *Journal) ReplayPrompt(text string) (string, error) {
	if len(j.Previous) == 0 {
		return text, nil
	}
	body, err := json.Marshal(j.Previous)
	if err != nil {
		return "", err
	}
	if len(body)+len(text) > 4<<20 {
		return "", errors.New("worker conversation exceeds the replay limit")
	}
	return "Previous conversation (JSON):\n" + string(body) + "\n\nCurrent instruction:\n" + text, nil
}
func (j *Journal) Emit(ctx context.Context, kind event.Type, value any, cause event.ID) (event.Event, error) {
	body, err := json.Marshal(value)
	if err != nil {
		return event.Event{}, err
	}
	return j.Bus.Publish(ctx, event.Event{Type: kind, Payload: body, Stream: event.Stream("session:" + j.Assignment.Session), Scope: j.Scope, Actor: event.Actor{Kind: event.ActorAgent, ID: j.Assignment.Claim.Member}, Cause: cause})
}
func (j *Journal) Input(ctx context.Context, in loop.Input) error {
	_, err := j.Emit(ctx, session.MessageSent, model.Message{Role: model.User, Parts: in.Parts}, in.Cause)
	return err
}
func (j *Journal) Message(ctx context.Context, msg session.Completion) error {
	j.partial = ""
	text := ""
	for _, part := range msg.Parts {
		text += part.Text
	}
	if text != "" {
		j.Last = text
	}
	_, err := j.Emit(ctx, session.MessageCompleted, msg, "")
	if err == nil {
		j.usage = j.usage.Add(msg.Usage)
	}
	return err
}

func (j *Journal) Delta(ctx context.Context, chunk model.Chunk) error {
	if chunk.Kind == model.Text {
		if len(j.partial)+len(chunk.Text) > 4<<20 {
			return errors.New("worker message exceeds 4 MiB")
		}
		j.partial += chunk.Text
	}
	_, err := j.Emit(ctx, session.MessageDelta, chunk, "")
	return err
}
func (j *Journal) Call(ctx context.Context, call model.ToolCall) error {
	if _, exists := j.calls[call.ID]; exists {
		return nil
	}
	fact, err := j.Emit(ctx, tool.Called, call, "")
	if err == nil {
		j.calls[call.ID] = fact
		j.order = append(j.order, call.ID)
	}
	return err
}
func (j *Journal) Complete(ctx context.Context, id string, result tool.Result) error {
	fact, ok := j.calls[id]
	if !ok {
		return nil
	}
	call, _ := event.Decode[model.ToolCall](fact)
	_, err := j.Emit(ctx, tool.Completed, tool.Completion{CallID: id, Name: call.Name, Result: result}, fact.ID)
	if err == nil {
		delete(j.calls, id)
	}
	return err
}
func (j *Journal) Finish(ctx context.Context, runErr error) (task.Report, error) {
	stop := loop.Answered
	if ctx.Err() != nil {
		stop, runErr = loop.Cancelled, ctx.Err()
	} else if errors.Is(runErr, context.Canceled) || errors.Is(runErr, context.DeadlineExceeded) {
		stop = loop.Cancelled
	} else if runErr != nil {
		stop = loop.Failed
	}
	ending, cancel := context.WithTimeout(context.WithoutCancel(ctx), 5*time.Second)
	defer cancel()
	if j.partial != "" {
		_ = j.Message(ending, session.Completion{Message: model.Message{Role: model.Assistant, Parts: []model.Part{{Text: j.partial}}}, Interrupted: stop != loop.Answered})
	}
	report := worker.ReportFromText(j.Assignment.Claim.ID, j.Last, stop, runErr)
	report.Usage = j.usage
	for _, id := range j.order {
		_ = j.Complete(ending, id, tool.Result{IsError: true, Code: "MRK-5003"})
	}
	_, err := j.Emit(ending, loop.TurnFinished, loop.Outcome{Stop: stop, Final: []model.Part{{Text: j.Last}}, Usage: j.usage}, "")
	if runErr == nil {
		runErr = err
	}
	return report, runErr
}
func Text(parts []model.Part) string {
	out := ""
	for _, part := range parts {
		out += part.Text
	}
	return out
}
