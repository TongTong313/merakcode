package engine

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"sort"
	"strings"

	"github.com/TongTong313/merakcode/merak/engine/event"
	"github.com/TongTong313/merakcode/merak/engine/group"
	"github.com/TongTong313/merakcode/merak/engine/leader"
	"github.com/TongTong313/merakcode/merak/engine/model"
	"github.com/TongTong313/merakcode/merak/engine/task"
	"github.com/TongTong313/merakcode/merak/engine/tool"
)

type groupTool struct {
	spec tool.Spec
	run  func(context.Context, tool.Call) (any, error)
}

func (t groupTool) Spec() tool.Spec { return t.spec }
func (t groupTool) Run(ctx context.Context, call tool.Call) (tool.Result, error) {
	value, err := t.run(ctx, call)
	if err != nil {
		return tool.Result{IsError: true, Code: "MRK-5001", Parts: []model.Part{{Text: err.Error()}}}, nil
	}
	body, err := json.Marshal(value)
	if err != nil {
		return tool.Result{}, err
	}
	return tool.Result{Parts: []model.Part{{Text: string(body)}}}, nil
}
func decodeGroupInput(body []byte, target any) error {
	decoder := json.NewDecoder(bytes.NewReader(body))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(target); err != nil {
		return err
	}
	if decoder.Decode(new(any)) != io.EOF {
		return errors.New("expected one JSON object")
	}
	return nil
}
func (e *Engine) taskRoot(ctx context.Context, card task.Card) (event.ID, error) {
	for card.Parent != "" {
		parent, err := e.Tasks.Get(ctx, card.Parent)
		if err != nil {
			return "", err
		}
		card = parent
	}
	return card.ID, nil
}
func (e *Engine) scopedTask(ctx context.Context, g event.ID, thread *leader.Thread, id event.ID) (task.Card, error) {
	card, err := e.Tasks.Get(ctx, id)
	if err != nil {
		return task.Card{}, err
	}
	root, err := e.taskRoot(ctx, card)
	if err != nil {
		return task.Card{}, err
	}
	if card.Group != g || thread.Key != g && root != thread.Key {
		return task.Card{}, errors.New("task is outside this leader thread")
	}
	return card, nil
}
func (e *Engine) leaderTools(g *groupRun, thread *leader.Thread, finish func(string)) []tool.Tool {
	tools := []tool.Tool{
		e.groupLookup(g.group.ID),
		e.readGroupDoc(g.group.ID),
		e.listGroupDocsTool(g.group.ID),
		e.writeGroupDocTool(g.group.ID, thread.Leader),
		e.gate.Wrap(tool.Remember{Memory: e.notes}),
		e.gate.Wrap(tool.Recall{Memory: e.notes}),
		e.approveTool(g, thread),
		e.setPhaseTool(g, thread),
		e.askHumanTool(g, thread, finish),
		e.messageMemberTool(g, thread),
		e.withdrawClaimTool(g, thread),
		e.setTaskPriorityTool(g, thread),
		e.updateTaskTool(g, thread),
		e.sayTool(g, thread, finish),
		e.mergeTool(g, thread),
		e.publishTool(g, thread),
		groupTool{spec: tool.Spec{Name: "create_task", Description: "Create and publish a task in this thread. Include a clear description, acceptance criteria and project-relative areas.", Effect: tool.EffectGroup, Input: json.RawMessage(`{"type":"object","properties":{"title":{"type":"string"},"description":{"type":"string"},"acceptance":{"type":"array","items":{"type":"string"}},"areas":{"type":"array","items":{"type":"string"}},"inputs":{"type":"array","items":{"type":"string"}},"workspace":{"type":"string","enum":["worktree","folder","inplace","none"]},"priority":{"type":"integer"},"review":{"type":"boolean"},"budget":{"type":"object","properties":{"maxSteps":{"type":"integer","minimum":0},"maxTokens":{"type":"integer","minimum":0},"maxCost":{"type":"number","minimum":0},"maxWallClock":{"type":"integer","minimum":0}},"additionalProperties":false}},"required":["title"],"additionalProperties":false}`)}, run: func(ctx context.Context, call tool.Call) (any, error) {
			var input struct {
				Title       string      `json:"title"`
				Description string      `json:"description"`
				Acceptance  []string    `json:"acceptance"`
				Areas       []string    `json:"areas"`
				Inputs      []string    `json:"inputs"`
				Workspace   string      `json:"workspace"`
				Priority    int         `json:"priority"`
				Review      bool        `json:"review"`
				Budget      task.Budget `json:"budget"`
			}
			if err := decodeGroupInput(call.Input, &input); err != nil {
				return nil, err
			}
			parent := thread.Session.Scope.Task
			return e.CreateTask(ctx, task.Card{Group: g.group.ID, Parent: parent, Title: input.Title, Description: input.Description, Acceptance: input.Acceptance, Areas: input.Areas, Inputs: input.Inputs, Workspace: input.Workspace, Priority: input.Priority, Review: input.Review, Budget: input.Budget, CreatedBy: event.Actor{Kind: event.ActorAgent, ID: thread.Leader}})
		}},
		groupTool{spec: tool.Spec{Name: "assign_task", Description: "Assign a task to a worker member. The first claim owns the task; collaborators require explicit non-overlapping scopes. Busy members queue the task.", Effect: tool.EffectGroup, Input: json.RawMessage(`{"type":"object","properties":{"task":{"type":"string"},"member":{"type":"string"},"role":{"type":"string","enum":["owner","collaborator"]},"scope":{"type":"array","items":{"type":"string"}}},"required":["task","member"],"additionalProperties":false}`)}, run: func(ctx context.Context, call tool.Call) (any, error) {
			var input struct {
				Task   event.ID       `json:"task"`
				Member event.ID       `json:"member"`
				Role   task.ClaimRole `json:"role"`
				Scope  []string       `json:"scope"`
			}
			if err := decodeGroupInput(call.Input, &input); err != nil {
				return nil, err
			}
			if _, err := e.scopedTask(ctx, g.group.ID, thread, input.Task); err != nil {
				return nil, err
			}
			if input.Role == "" {
				input.Role = task.RoleOwner
			}
			return e.Tasks.Assign(ctx, input.Task, input.Member, input.Role, input.Scope)
		}},
		groupTool{spec: tool.Spec{Name: "read_report", Description: "Read the bounded reports for a task in this thread.", Effect: tool.EffectRead, Input: json.RawMessage(`{"type":"object","properties":{"task":{"type":"string"}},"required":["task"],"additionalProperties":false}`)}, run: func(ctx context.Context, call tool.Call) (any, error) {
			var input struct {
				Task event.ID `json:"task"`
			}
			if err := decodeGroupInput(call.Input, &input); err != nil {
				return nil, err
			}
			card, err := e.scopedTask(ctx, g.group.ID, thread, input.Task)
			if err != nil {
				return nil, err
			}
			var reports []task.Report
			for _, claim := range card.Claims {
				if claim.Report != nil {
					reports = append(reports, *claim.Report)
				}
			}
			if len(reports) == 0 {
				return nil, errors.New("task has no submitted report")
			}
			return reports, nil
		}},
		groupTool{spec: tool.Spec{Name: "notify_human", Description: "Send a concise notice to the task owner. A final notice closes successfully reported tasks in this thread and ends the turn. It is refused while work is incomplete.", Effect: tool.EffectGroup, Input: json.RawMessage(`{"type":"object","properties":{"kind":{"type":"string","enum":["info","final"]},"text":{"type":"string","minLength":1,"maxLength":1200}},"required":["kind","text"],"additionalProperties":false}`)}, run: func(ctx context.Context, call tool.Call) (any, error) {
			var input struct {
				Kind string `json:"kind"`
				Text string `json:"text"`
			}
			if err := decodeGroupInput(call.Input, &input); err != nil {
				return nil, err
			}
			if input.Kind != "info" && input.Kind != "final" || strings.TrimSpace(input.Text) == "" || len([]rune(input.Text)) > 1200 {
				return nil, errors.New("notice requires info or final and text within 1200 characters")
			}
			if input.Kind == "final" {
				if err := e.finishTasks(ctx, g.group.ID, thread); err != nil {
					return nil, err
				}
			}
			state, err := e.Groups.Get(ctx, g.group.ID)
			if err != nil {
				return nil, err
			}
			var recipients []event.ID
			for _, member := range state.Members {
				if member.Kind == group.MemberHuman {
					recipients = append(recipients, member.ID)
				}
			}
			notice := group.Notice{Kind: input.Kind, Text: input.Text, To: recipients}
			body, _ := json.Marshal(notice)
			_, err = e.Bus.Publish(ctx, event.Event{Stream: event.Stream("group:" + g.group.ID), Scope: event.Scope{Group: g.group.ID, Task: thread.Session.Scope.Task}, Type: group.NoticeSent, Actor: event.Actor{Kind: event.ActorAgent, ID: thread.Leader}, Payload: body})
			if err == nil && input.Kind == "final" {
				finish(input.Text)
			}
			return notice, err
		}},
	}
	if thread.Key == g.group.ID {
		tools = append(tools, e.setTaskLeaderTool(g, thread))
	}
	return tools
}
func (e *Engine) finishTasks(ctx context.Context, groupID event.ID, thread *leader.Thread) error {
	if thread.Session.Scope.Task == "" {
		return errors.New("final delivery requires a task thread")
	}
	card, err := e.Tasks.Get(ctx, thread.Key)
	if err != nil {
		return err
	}
	if card.Group != groupID || card.Phase != task.PhaseDone || card.Status != task.Done {
		return errors.New("final delivery requires a completed goal")
	}
	return nil
}

func (e *Engine) finishGoal(ctx context.Context, groupID, goalID event.ID) error {
	cards, err := e.Tasks.List(ctx, groupID)
	if err != nil {
		return err
	}
	var selected []task.Card
	depth := map[event.ID]int{}
	for _, card := range cards {
		root, err := e.taskRoot(ctx, card)
		if err != nil {
			return err
		}
		if root != goalID {
			continue
		}
		selected = append(selected, card)
		parent := card.Parent
		for parent != "" {
			depth[card.ID]++
			value, err := e.Tasks.Get(ctx, parent)
			if err != nil {
				return err
			}
			parent = value.Parent
		}
	}
	sort.SliceStable(selected, func(i, j int) bool { return depth[selected[i].ID] > depth[selected[j].ID] })
	for _, card := range selected {
		if card.Status == task.Done {
			continue
		}
		if err := e.Tasks.Close(ctx, card.ID, task.Done); err != nil {
			return err
		}
	}
	return nil
}
