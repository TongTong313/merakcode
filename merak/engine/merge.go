package engine

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"

	"github.com/TongTong313/merakcode/merak/engine/agent"
	"github.com/TongTong313/merakcode/merak/engine/event"
	"github.com/TongTong313/merakcode/merak/engine/group"
	"github.com/TongTong313/merakcode/merak/engine/leader"
	"github.com/TongTong313/merakcode/merak/engine/permission"
	"github.com/TongTong313/merakcode/merak/engine/task"
	"github.com/TongTong313/merakcode/merak/engine/tool"
	"github.com/TongTong313/merakcode/merak/engine/worker"
	"github.com/TongTong313/merakcode/merak/engine/workspace"
	"github.com/TongTong313/merakcode/merak/internal/platform/git"
)

func (e *Engine) mergeTool(g *groupRun, thread *leader.Thread) tool.Tool {
	return groupTool{spec: tool.Spec{Name: "request_merge", Description: "Queue a successfully reported claim for integration into the group target branch. Integration runs asynchronously; wait for merge.done or merge.conflicted.", Effect: tool.EffectGroup, Input: json.RawMessage(`{"type":"object","properties":{"task":{"type":"string"},"claim":{"type":"string"}},"required":["task","claim"],"additionalProperties":false}`)}, run: func(ctx context.Context, call tool.Call) (any, error) {
		var input struct {
			Task  event.ID `json:"task"`
			Claim event.ID `json:"claim"`
		}
		if err := decodeGroupInput(call.Input, &input); err != nil {
			return nil, err
		}
		card, err := e.scopedTask(ctx, g.group.ID, thread, input.Task)
		if err != nil {
			return nil, err
		}
		return e.requestMerge(ctx, card, input.Claim)
	}}
}

func (e *Engine) requestMerge(ctx context.Context, card task.Card, claimID event.ID) (any, error) {
	var claim task.Claim
	for _, candidate := range card.Claims {
		if candidate.ID == claimID {
			claim = candidate
			break
		}
	}
	if claim.Report == nil || claim.Report.Verdict != task.VerdictDone || claim.Integrated != "" || card.Workspace != workspace.KindWorktree {
		return nil, errors.New("merge requires an unintegrated successful worktree report")
	}
	e.mu.Lock()
	if e.merging[claim.ID] {
		e.mu.Unlock()
		return map[string]event.ID{"queued": claim.ID}, nil
	}
	e.merging[claim.ID] = true
	e.mu.Unlock()
	launched := false
	defer func() {
		if !launched {
			e.mu.Lock()
			delete(e.merging, claim.ID)
			e.mu.Unlock()
		}
	}()
	member, err := e.groupMember(ctx, card.Group, claim.Member)
	if err != nil {
		return nil, err
	}
	p, err := e.memberAgent(ctx, member)
	if err != nil {
		return nil, err
	}
	var source *agent.RemoteSource
	var ws workspace.Workspace
	if p.Product != nil && p.Product.Kind == worker.KindRemote {
		source = p.Product.Remote
		if source == nil {
			return nil, errors.New("remote source is missing")
		}
		ws, err = e.prepareRemoteDelivery(ctx, card, claim, *source)
		claim.Workspace = ws.ID
	} else {
		ws, err = e.Workspaces.Get(ctx, claim.Workspace)
	}
	if err != nil {
		return nil, err
	}
	if card.Review && (card.LastReview == nil || card.LastReview.Decision != "approve" || card.LastReview.Phase == task.PhasePlanning) {
		if source != nil {
			return map[string]event.ID{"review": claim.ID}, nil
		}
		return nil, errors.New("merge requires human approval")
	}
	state, err := e.Groups.Get(ctx, card.Group)
	if err != nil {
		return nil, err
	}
	e.mu.Lock()
	defer e.mu.Unlock()
	if e.ctx.Err() != nil {
		return nil, e.ctx.Err()
	}
	launched = true
	e.workers.Go(func() {
		defer func() { e.mu.Lock(); delete(e.merging, claim.ID); e.mu.Unlock() }()
		if state.Group.Settings.MergeApprovalRequired() {
			input, _ := json.Marshal(map[string]any{"task": card.ID, "claim": claim.ID, "target": state.Group.Brief.TargetBranch})
			reply, err := e.permissions.Ask(e.ctx, permission.Request{Kind: "merge", Member: state.Group.Leader,
				Spec: tool.Spec{Name: "request_merge", Effect: tool.EffectGroup},
				Call: tool.Call{Input: input, Env: tool.Env{Workdir: ws.Directory, Scope: event.Scope{Group: card.Group, Task: card.ID, Session: claim.Session}}},
			})
			if err != nil || reply.Decision != permission.Allow {
				return
			}
		}
		result, err := e.Workspaces.Integrate(e.ctx, ws, state.Group.Brief.TargetBranch, state.Group.Brief.Check)
		if err == nil && source != nil && result.Head != "" && len(result.Conflicts) == 0 {
			err = git.PushBranch(e.ctx, state.Group.Project.Directory, state.Group.Project.Remote, ws.Branch, true)
			if err == nil {
				_, err = e.remoteDelivery(e.ctx, *source, claim, true)
			}
		}
		if err != nil {
			var check *workspace.CheckFailure
			if errors.As(err, &check) {
				if e.returnToDoing(e.ctx, card) != nil {
					return
				}
				if e.Tasks.Rework(e.ctx, claim.ID, check.Error()) == nil {
					e.mu.Lock()
					g := e.groupRuns[card.Group]
					e.mu.Unlock()
					if g != nil {
						e.startMember(g, claim.Member)
					}
				}
				return
			}
			body, _ := json.Marshal(group.Notice{Kind: "info", Text: "MRK-6001: Claim integration failed. Inspect the worktree and target branch before retrying."})
			_, _ = e.Bus.Publish(e.ctx, event.Event{Stream: event.Stream("group:" + card.Group), Scope: event.Scope{Group: card.Group, Task: card.ID}, Type: group.NoticeSent, Actor: e.leaderActor(ctx, card), Payload: body})
			return
		}
	})
	return map[string]event.ID{"queued": claim.ID}, nil
}

func (e *Engine) createIntegrationTask(ctx context.Context, g *groupRun, fact event.Event) error {
	result, err := event.Decode[workspace.Integration](fact)
	if err != nil {
		return err
	}
	ws, err := e.Workspaces.Get(ctx, result.Workspace)
	if err != nil {
		return err
	}
	cards, err := e.Tasks.List(ctx, g.group.ID)
	if err != nil {
		return err
	}
	for _, card := range cards {
		if card.IntegrationOf == result.Claim {
			return nil
		}
	}
	original, err := e.Tasks.Get(ctx, ws.Task)
	if err != nil {
		return err
	}
	if err := e.returnToDoing(ctx, original); err != nil {
		return err
	}
	base, err := git.Current(ctx, ws.Directory)
	if err != nil {
		return err
	}
	card, err := e.CreateTask(ctx, task.Card{Group: g.group.ID, Parent: original.ID, Title: "Integrate " + original.Title, Description: fmt.Sprintf("Rebase this worktree onto refs/heads/%s and resolve these conflicting files: %s. Preserve both the target changes and the original task result. Verify and commit the resolution, then submit_report. The original claim is %s.", result.Target, strings.Join(result.Conflicts, ", "), result.Claim), Acceptance: []string{"Resolve the reported conflicts and preserve both results.", "Verify the resolved result before reporting."}, Areas: result.Conflicts, Workspace: workspace.KindWorktree, Base: base, IntegrationOf: result.Claim, Review: original.Review, CreatedBy: e.leaderActor(ctx, original)})
	if err != nil {
		return err
	}
	_, err = e.Tasks.Assign(ctx, card.ID, ws.Member, task.RoleOwner, result.Conflicts)
	return err
}

func (e *Engine) returnToDoing(ctx context.Context, card task.Card) error {
	id, err := e.taskRoot(ctx, card)
	if err != nil {
		return err
	}
	goal, err := e.Tasks.Get(ctx, id)
	if err != nil {
		return err
	}
	if goal.Phase != task.PhaseIntegrating {
		return nil
	}
	return e.Tasks.SetPhase(ctx, id, task.PhaseDoing, e.leaderActor(ctx, goal))
}

func (e *Engine) completeIntegration(ctx context.Context, fact event.Event) error {
	result, err := event.Decode[workspace.Integration](fact)
	if err != nil {
		return err
	}
	card, err := e.Tasks.Get(ctx, fact.Scope.Task)
	if err != nil {
		return err
	}
	claim := result.Claim
	for {
		if err := e.Tasks.MarkIntegrated(ctx, claim, result.Head); err != nil {
			return err
		}
		if err := e.Tasks.Close(ctx, card.ID, task.Done); err != nil && !errors.Is(err, task.ErrState) {
			return err
		}
		if card.IntegrationOf == "" {
			return e.advancePhase(ctx, event.Event{Type: task.Updated, Scope: event.Scope{Task: card.ID}})
		}
		claim = card.IntegrationOf
		card, err = e.Tasks.Get(ctx, card.Parent)
		if err != nil {
			return err
		}
	}
}
