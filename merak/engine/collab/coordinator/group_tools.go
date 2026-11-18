package coordinator

import (
	"context"
	"encoding/json"
	"errors"
	"sort"
	"strings"

	"github.com/TongTong313/merakcode/merak/engine/agent/tool"
	"github.com/TongTong313/merakcode/merak/engine/collab/group"
	"github.com/TongTong313/merakcode/merak/engine/collab/leader"
	"github.com/TongTong313/merakcode/merak/engine/collab/roster"
	"github.com/TongTong313/merakcode/merak/engine/collab/task"
	"github.com/TongTong313/merakcode/merak/engine/infra/event"
)

func (domain *Coordinator) leaderTools(g *groupRun, thread *leader.Thread, finish func(string)) []tool.Tool {
	tools := []tool.Tool{
		domain.remote.GroupLookup(g.group.ID),
		domain.remote.ReadGroupDoc(g.group.ID),
		domain.roster.ListGroupDocsTool(g.group.ID),
		domain.roster.WriteGroupDocTool(g.group.ID, thread.Leader),
		domain.gate.Wrap(tool.Remember{Memory: domain.notes}),
		domain.gate.Wrap(tool.Recall{Memory: domain.notes}),
		domain.approveTool(g, thread),
		domain.setPhaseTool(g, thread),
		domain.askHumanTool(g, thread, finish),
		domain.messageMemberTool(g, thread),
		domain.withdrawClaimTool(g, thread),
		domain.setTaskPriorityTool(g, thread),
		domain.updateTaskTool(g, thread),
		domain.sayTool(g, thread, finish),
		domain.mergeTool(g, thread),
		domain.publishTool(g, thread),
		roster.GroupTool{Definition: tool.Spec{Name: "create_task", Description: "Create and publish a task in this group; give parent to make it a subtask of one of its tasks. Include a clear description, acceptance criteria and project-relative areas.", Effect: tool.EffectGroup, Input: json.RawMessage(`{"type":"object","properties":{"parent":{"type":"string"},"title":{"type":"string"},"description":{"type":"string"},"acceptance":{"type":"array","items":{"type":"string"}},"areas":{"type":"array","items":{"type":"string"}},"inputs":{"type":"array","items":{"type":"string"}},"workspace":{"type":"string","enum":["worktree","folder","inplace","none"]},"priority":{"type":"integer"},"review":{"type":"boolean"},"budget":{"type":"object","properties":{"maxSteps":{"type":"integer","minimum":0},"maxTokens":{"type":"integer","minimum":0},"maxCost":{"type":"number","minimum":0},"maxWallClock":{"type":"integer","minimum":0}},"additionalProperties":false}},"required":["title"],"additionalProperties":false}`)}, RunFunc: func(ctx context.Context, call tool.Call) (any, error) {
			var input struct {
				Parent      event.ID    `json:"parent"`
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
			if err := roster.DecodeGroupInput(call.Input, &input); err != nil {
				return nil, err
			}
			if input.Parent != "" {
				if _, err := domain.roster.ScopedTask(ctx, g.group.ID, thread, input.Parent); err != nil {
					return nil, err
				}
			}
			return domain.CreateTask(ctx, task.Card{Group: g.group.ID, Parent: input.Parent, Title: input.Title, Description: input.Description, Acceptance: input.Acceptance, Areas: input.Areas, Inputs: input.Inputs, Workspace: input.Workspace, Priority: input.Priority, Review: input.Review, Budget: input.Budget, CreatedBy: event.Actor{Kind: event.ActorAgent, ID: thread.Leader}})
		}},
		roster.GroupTool{Definition: tool.Spec{Name: "assign_task", Description: "Assign a task to a worker member. The first claim owns the task; collaborators require explicit non-overlapping scopes. Busy members queue the task.", Effect: tool.EffectGroup, Input: json.RawMessage(`{"type":"object","properties":{"task":{"type":"string"},"member":{"type":"string"},"role":{"type":"string","enum":["owner","collaborator"]},"scope":{"type":"array","items":{"type":"string"}}},"required":["task","member"],"additionalProperties":false}`)}, RunFunc: func(ctx context.Context, call tool.Call) (any, error) {
			var input struct {
				Task   event.ID       `json:"task"`
				Member event.ID       `json:"member"`
				Role   task.ClaimRole `json:"role"`
				Scope  []string       `json:"scope"`
			}
			if err := roster.DecodeGroupInput(call.Input, &input); err != nil {
				return nil, err
			}
			if _, err := domain.roster.ScopedTask(ctx, g.group.ID, thread, input.Task); err != nil {
				return nil, err
			}
			if input.Role == "" {
				input.Role = task.RoleOwner
			}
			return domain.tasks.Assign(ctx, input.Task, input.Member, input.Role, input.Scope)
		}},
		roster.GroupTool{Definition: tool.Spec{Name: "read_report", Description: "Read the bounded reports for a task in this thread.", Effect: tool.EffectRead, Input: json.RawMessage(`{"type":"object","properties":{"task":{"type":"string"}},"required":["task"],"additionalProperties":false}`)}, RunFunc: func(ctx context.Context, call tool.Call) (any, error) {
			var input struct {
				Task event.ID `json:"task"`
			}
			if err := roster.DecodeGroupInput(call.Input, &input); err != nil {
				return nil, err
			}
			card, err := domain.roster.ScopedTask(ctx, g.group.ID, thread, input.Task)
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
		roster.GroupTool{Definition: tool.Spec{Name: "notify_human", Description: "Send a concise notice to the task owner. A final notice closes successfully reported tasks in this thread and ends the turn. It is refused while work is incomplete.", Effect: tool.EffectGroup, Input: json.RawMessage(`{"type":"object","properties":{"kind":{"type":"string","enum":["info","final"]},"text":{"type":"string","minLength":1,"maxLength":1200}},"required":["kind","text"],"additionalProperties":false}`)}, RunFunc: func(ctx context.Context, call tool.Call) (any, error) {
			var input struct {
				Kind string `json:"kind"`
				Text string `json:"text"`
			}
			if err := roster.DecodeGroupInput(call.Input, &input); err != nil {
				return nil, err
			}
			if input.Kind != "info" && input.Kind != "final" || strings.TrimSpace(input.Text) == "" || len([]rune(input.Text)) > 1200 {
				return nil, errors.New("notice requires info or final and text within 1200 characters")
			}
			if input.Kind == "final" {
				if err := domain.finishTasks(ctx, g.group.ID); err != nil {
					return nil, err
				}
			}
			state, err := domain.groups.Get(ctx, g.group.ID)
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
			_, err = domain.core.Bus.Publish(ctx, event.Event{Stream: event.Stream("group:" + g.group.ID), Scope: event.Scope{Group: g.group.ID}, Type: group.NoticeSent, Actor: event.Actor{Kind: event.ActorAgent, ID: thread.Leader}, Payload: body})
			if err == nil && input.Kind == "final" {
				finish(input.Text)
			}
			return notice, err
		}},
	}
	return tools
}

// finishTasks says whether a final notice may be sent: every goal of the group is completed or cancelled.
func (domain *Coordinator) finishTasks(ctx context.Context, groupID event.ID) error {
	cards, err := domain.tasks.List(ctx, groupID)
	if err != nil {
		return err
	}
	for _, card := range cards {
		if card.Parent == "" && card.Status != task.Cancelled && (card.Phase != task.PhaseDone || card.Status != task.Done) {
			return errors.New("final delivery requires every goal to be completed")
		}
	}
	return nil
}

func (domain *Coordinator) finishGoal(ctx context.Context, groupID, goalID event.ID) error {
	cards, err := domain.tasks.List(ctx, groupID)
	if err != nil {
		return err
	}
	var selected []task.Card
	depth := map[event.ID]int{}
	for _, card := range cards {
		root, err := domain.roster.TaskRoot(ctx, card)
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
			value, err := domain.tasks.Get(ctx, parent)
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
		if err := domain.tasks.Close(ctx, card.ID, task.Done); err != nil {
			return err
		}
	}
	return nil
}
