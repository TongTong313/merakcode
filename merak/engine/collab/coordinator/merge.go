package coordinator

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"

	"github.com/TongTong313/merakcode/merak/engine/agent/definition"
	"github.com/TongTong313/merakcode/merak/engine/agent/permission"
	"github.com/TongTong313/merakcode/merak/engine/agent/tool"
	"github.com/TongTong313/merakcode/merak/engine/collab/group"
	"github.com/TongTong313/merakcode/merak/engine/collab/leader"
	"github.com/TongTong313/merakcode/merak/engine/collab/roster"
	"github.com/TongTong313/merakcode/merak/engine/collab/task"
	"github.com/TongTong313/merakcode/merak/engine/collab/workspace"
	"github.com/TongTong313/merakcode/merak/engine/infra/event"
	"github.com/TongTong313/merakcode/merak/engine/infra/git"
)

func (domain *Coordinator) mergeTool(g *groupRun, thread *leader.Thread) tool.Tool {
	return roster.GroupTool{Definition: tool.Spec{Name: "request_merge", Description: "Queue a successfully reported claim for integration into the group target branch. Integration runs asynchronously; wait for merge.done or merge.conflicted.", Effect: tool.EffectGroup, Input: json.RawMessage(`{"type":"object","properties":{"task":{"type":"string"},"claim":{"type":"string"}},"required":["task","claim"],"additionalProperties":false}`)}, RunFunc: func(ctx context.Context, call tool.Call) (any, error) {
		var input struct {
			Task  event.ID `json:"task"`
			Claim event.ID `json:"claim"`
		}
		if err := roster.DecodeGroupInput(call.Input, &input); err != nil {
			return nil, err
		}
		card, err := domain.roster.ScopedTask(ctx, g.group.ID, thread, input.Task)
		if err != nil {
			return nil, err
		}
		return domain.requestMerge(ctx, card, input.Claim)
	}}
}

func (domain *Coordinator) requestMerge(ctx context.Context, card task.Card, claimID event.ID) (any, error) {
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
	domain.mu.Lock()
	if domain.merging[claim.ID] {
		domain.mu.Unlock()
		return map[string]event.ID{"queued": claim.ID}, nil
	}
	domain.merging[claim.ID] = true
	domain.mu.Unlock()
	launched := false
	defer func() {
		if !launched {
			domain.mu.Lock()
			delete(domain.merging, claim.ID)
			domain.mu.Unlock()
		}
	}()
	member, err := domain.roster.GroupMember(ctx, card.Group, claim.Member)
	if err != nil {
		return nil, err
	}
	p, err := domain.roster.MemberAgent(ctx, member)
	if err != nil {
		return nil, err
	}
	var source *definition.RemoteSource
	var ws workspace.Workspace
	if p.Product != nil && p.Product.Kind == definition.KindRemote {
		source = p.Product.Remote
		if source == nil {
			return nil, errors.New("remote source is missing")
		}
		ws, err = domain.remote.PrepareRemoteDelivery(ctx, card, claim, *source)
		claim.Workspace = ws.ID
	} else {
		ws, err = domain.workspaces.Get(ctx, claim.Workspace)
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
	state, err := domain.groups.Get(ctx, card.Group)
	if err != nil {
		return nil, err
	}
	domain.mu.Lock()
	defer domain.mu.Unlock()
	if domain.core.Ctx.Err() != nil {
		return nil, domain.core.Ctx.Err()
	}
	launched = true
	domain.core.Workers.Go(func() {
		defer func() { domain.mu.Lock(); delete(domain.merging, claim.ID); domain.mu.Unlock() }()
		if state.Group.Settings.MergeApprovalRequired() {
			input, _ := json.Marshal(map[string]any{"task": card.ID, "claim": claim.ID, "target": state.Group.Brief.TargetBranch})
			reply, err := domain.permissions.Ask(domain.core.Ctx, permission.Request{Kind: "merge", Member: state.Group.Leader,
				Spec: tool.Spec{Name: "request_merge", Effect: tool.EffectGroup},
				Call: tool.Call{Input: input, Env: tool.Env{Workdir: ws.Directory, Scope: event.Scope{Group: card.Group, Task: card.ID, Session: claim.Session}}},
			})
			if err != nil || reply.Decision != permission.Allow {
				return
			}
		}
		result, err := domain.workspaces.Integrate(domain.core.Ctx, ws, state.Group.Brief.TargetBranch, state.Group.Brief.Check)
		if err == nil && source != nil && result.Head != "" && len(result.Conflicts) == 0 {
			err = git.PushBranch(domain.core.Ctx, state.Group.Project.Directory, state.Group.Project.Remote, ws.Branch, true)
			if err == nil {
				_, err = domain.remote.RemoteDelivery(domain.core.Ctx, *source, claim, true)
			}
		}
		if err != nil {
			var check *workspace.CheckFailure
			if errors.As(err, &check) {
				if domain.returnToDoing(domain.core.Ctx, card) != nil {
					return
				}
				if domain.tasks.Rework(domain.core.Ctx, claim.ID, check.Error()) == nil {
					domain.mu.Lock()
					g := domain.groupRuns[card.Group]
					domain.mu.Unlock()
					if g != nil {
						domain.startMember(g, claim.Member)
					}
				}
				return
			}
			body, _ := json.Marshal(group.Notice{Kind: "info", Text: "MRK-6001: Claim integration failed. Inspect the worktree and target branch before retrying."})
			_, _ = domain.core.Bus.Publish(domain.core.Ctx, event.Event{Stream: event.Stream("group:" + card.Group), Scope: event.Scope{Group: card.Group, Task: card.ID}, Type: group.NoticeSent, Actor: domain.roster.LeaderActor(ctx, card), Payload: body})
			return
		}
	})
	return map[string]event.ID{"queued": claim.ID}, nil
}

func (domain *Coordinator) createIntegrationTask(ctx context.Context, g *groupRun, fact event.Event) error {
	result, err := event.Decode[workspace.Integration](fact)
	if err != nil {
		return err
	}
	ws, err := domain.workspaces.Get(ctx, result.Workspace)
	if err != nil {
		return err
	}
	cards, err := domain.tasks.List(ctx, g.group.ID)
	if err != nil {
		return err
	}
	for _, card := range cards {
		if card.IntegrationOf == result.Claim {
			return nil
		}
	}
	original, err := domain.tasks.Get(ctx, ws.Task)
	if err != nil {
		return err
	}
	if err := domain.returnToDoing(ctx, original); err != nil {
		return err
	}
	base, err := git.Current(ctx, ws.Directory)
	if err != nil {
		return err
	}
	card, err := domain.CreateTask(ctx, task.Card{Group: g.group.ID, Parent: original.ID, Title: "Integrate " + original.Title, Description: fmt.Sprintf("Rebase this worktree onto refs/heads/%s and resolve these conflicting files: %s. Preserve both the target changes and the original task result. Verify and commit the resolution, then submit_report. The original claim is %s.", result.Target, strings.Join(result.Conflicts, ", "), result.Claim), Acceptance: []string{"Resolve the reported conflicts and preserve both results.", "Verify the resolved result before reporting."}, Areas: result.Conflicts, Workspace: workspace.KindWorktree, Base: base, IntegrationOf: result.Claim, Review: original.Review, CreatedBy: domain.roster.LeaderActor(ctx, original)})
	if err != nil {
		return err
	}
	_, err = domain.tasks.Assign(ctx, card.ID, ws.Member, task.RoleOwner, result.Conflicts)
	return err
}

func (domain *Coordinator) returnToDoing(ctx context.Context, card task.Card) error {
	id, err := domain.roster.TaskRoot(ctx, card)
	if err != nil {
		return err
	}
	goal, err := domain.tasks.Get(ctx, id)
	if err != nil {
		return err
	}
	if goal.Phase != task.PhaseIntegrating {
		return nil
	}
	return domain.tasks.SetPhase(ctx, id, task.PhaseDoing, domain.roster.LeaderActor(ctx, goal))
}

func (domain *Coordinator) completeIntegration(ctx context.Context, fact event.Event) error {
	result, err := event.Decode[workspace.Integration](fact)
	if err != nil {
		return err
	}
	card, err := domain.tasks.Get(ctx, fact.Scope.Task)
	if err != nil {
		return err
	}
	claim := result.Claim
	for {
		if err := domain.tasks.MarkIntegrated(ctx, claim, result.Head); err != nil {
			return err
		}
		if err := domain.tasks.Close(ctx, card.ID, task.Done); err != nil && !errors.Is(err, task.ErrState) {
			return err
		}
		if card.IntegrationOf == "" {
			return domain.advancePhase(ctx, event.Event{Type: task.Updated, Scope: event.Scope{Task: card.ID}})
		}
		claim = card.IntegrationOf
		card, err = domain.tasks.Get(ctx, card.Parent)
		if err != nil {
			return err
		}
	}
}
