package coordinator

import (
	"context"
	"encoding/json"
	"slices"
	"time"

	"github.com/TongTong313/merakcode/merak/engine/agent/loop"
	"github.com/TongTong313/merakcode/merak/engine/agent/session"
	"github.com/TongTong313/merakcode/merak/engine/collab/group"
	"github.com/TongTong313/merakcode/merak/engine/collab/leader"
	"github.com/TongTong313/merakcode/merak/engine/collab/task"
	"github.com/TongTong313/merakcode/merak/engine/infra/event"
	"github.com/TongTong313/merakcode/merak/engine/infra/store"
)

func (domain *Coordinator) WatchSentinel(every time.Duration) {
	if every <= 0 {
		every = time.Minute
	}
	filter := event.Filter{Types: []event.Type{session.MessageDelta}}
	facts, stop := domain.core.Bus.Subscribe(filter)
	domain.core.Workers.Go(func() {
		defer func() { stop() }()
		ticker := time.NewTicker(every)
		defer ticker.Stop()
		activity := make(map[event.ID]event.Event)
		for {
			select {
			case <-domain.core.Ctx.Done():
				return
			case fact, ok := <-facts:
				if !ok {
					stop()
					facts, stop = domain.core.Bus.Subscribe(filter)
					continue
				}
				if fact.Scope.Session != "" && fact.Stream == event.Stream("session:"+fact.Scope.Session) {
					activity[fact.Scope.Session] = fact
				}
			case <-ticker.C:
				domain.inspectClaims(domain.core.Ctx, activity)
			}
		}
	})
}

func (domain *Coordinator) inspectClaims(ctx context.Context, activity map[event.ID]event.Event) {
	claimed := make(map[event.ID]bool)
	groups, err := domain.core.Store.Find(ctx, store.Query{Types: []event.Type{group.Created}})
	if err != nil {
		return
	}
	for _, created := range groups {
		cards, err := domain.tasks.List(ctx, created.Scope.Group)
		if err != nil {
			continue
		}
		state, decodeErr := event.Decode[group.State](created)
		_, hosted := domain.roster.HostedGroup(created.Scope.Group)
		if decodeErr == nil && (state.Group.Kind == group.KindCloud || hosted) {
			for _, card := range cards {
				for _, claim := range card.Claims {
					claimed[claim.Session] = true
				}
			}
			continue
		}
		history, err := domain.core.Store.Find(ctx, store.Query{Scope: event.Scope{Group: created.Scope.Group}})
		if err != nil {
			continue
		}
		view := leader.SentinelView{Now: domain.core.Now()}
		statuses := make(map[event.ID]task.ClaimStatus)
		for _, card := range cards {
			for _, claim := range card.Claims {
				claimed[claim.Session] = true
				statuses[claim.ID] = claim.Status
				if claim.Status != task.ClaimActive {
					continue
				}
				c := leader.ClaimView{Claim: claim.ID, Task: card.ID, Member: claim.Member, Session: claim.Session, Active: true, MaxTokens: card.Budget.MaxTokens, MaxCost: card.Budget.MaxCost}
				c.Running, c.Preparing = domain.execution.ClaimStatus(claim.ID)
				for _, fact := range history {
					if fact.Type == task.Started && fact.Scope.Task == card.ID && fact.Actor.ID == claim.Member {
						saved, _ := event.Decode[task.Card](fact)
						if slices.ContainsFunc(saved.Claims, func(value task.Claim) bool { return value.ID == claim.ID && value.Status == task.ClaimActive }) {
							c.Started, c.LastActivity, c.LastEvent = fact.Time, fact.Time, fact.ID
							c.Events = nil
						}
					}
					if fact.Scope.Session == claim.Session && fact.Stream == event.Stream("session:"+claim.Session) {
						c.LastActivity, c.LastEvent = fact.Time, fact.ID
						c.Events = append(c.Events, fact)
					}
					if fact.Type == FileChanged {
						changes, _ := event.Decode[FileChanges](fact)
						owned := fact.Scope.Task == card.ID
						for _, id := range changes.Claims {
							owned = owned || id == claim.ID
						}
						if owned {
							c.Events = append(c.Events, fact)
						}
					}
					if fact.Type == RepoChanged {
						changes, _ := event.Decode[RepoChanges](fact)
						owned := fact.Scope.Task == card.ID
						for _, id := range changes.Claims {
							owned = owned || id == claim.ID
						}
						if owned {
							c.Events = append(c.Events, fact)
						}
					}
				}
				if recent, ok := activity[claim.Session]; ok && recent.Time.After(c.LastActivity) {
					c.LastActivity, c.LastEvent = recent.Time, recent.ID
				}
				view.Claims = append(view.Claims, c)
			}
		}
		for _, finding := range leader.Inspect(view) {
			_ = domain.flagFinding(ctx, created.Scope.Group, finding)
		}
		// Re-read after interruptions so stale leases can be released in the same patrol.
		cards, err = domain.tasks.List(ctx, created.Scope.Group)
		if err != nil {
			continue
		}
		for _, card := range cards {
			for _, claim := range card.Claims {
				statuses[claim.ID] = claim.Status
			}
		}
		docs, err := domain.core.Store.List(ctx, "workspace", "")
		if err != nil {
			continue
		}
		leases := leader.SentinelView{Now: domain.core.Now()}
		for _, doc := range docs {
			ws, err := domain.workspaces.Get(ctx, event.ID(doc.Key))
			if err != nil || ws.Group != created.Scope.Group {
				continue
			}
			status, known := statuses[ws.Claim]
			leases.Leases = append(leases.Leases, leader.LeaseView{Workspace: ws, Ended: known && status != task.ClaimActive && status != task.ClaimQueued})
		}
		for _, finding := range leader.Inspect(leases) {
			_ = domain.flagFinding(ctx, created.Scope.Group, finding)
		}
	}
	domain.inspectSessions(ctx, claimed)
}

func (domain *Coordinator) inspectSessions(ctx context.Context, claimed map[event.ID]bool) {
	created, err := domain.core.Store.Find(ctx, store.Query{Types: []event.Type{session.Created}})
	if err != nil {
		return
	}
	for _, fact := range created {
		if claimed[fact.Scope.Session] {
			continue
		}
		history, err := domain.core.Store.Read(ctx, fact.Stream, 1, 0)
		if err != nil {
			continue
		}
		active := false
		for _, item := range history {
			if item.Type == loop.TurnStarted {
				active = true
			}
			if item.Type == loop.TurnFinished {
				active = false
			}
		}
		if !active {
			continue
		}
		saved, err := event.Decode[session.State](fact)
		if err != nil {
			continue
		}
		view := leader.ClaimView{Active: true, Running: true, Session: fact.Scope.Session, Member: saved.Config.Member, Task: fact.Scope.Task, Events: history}
		for _, finding := range leader.Inspect(leader.SentinelView{Now: domain.core.Now(), Claims: []leader.ClaimView{view}}) {
			_ = domain.flagFinding(ctx, fact.Scope.Group, finding)
		}
	}
}

func (domain *Coordinator) flagFinding(ctx context.Context, groupID event.ID, finding leader.Finding) error {
	domain.sentinelMu.Lock()
	defer domain.sentinelMu.Unlock()
	body, _ := json.Marshal(finding)
	key := string(groupID) + string(body)
	if finding.Rule == "claim.budget" {
		key = string(groupID) + "/claim.budget/" + string(finding.Claim)
	}
	if domain.sentinelSeen[key] {
		return nil
	}
	switch finding.Action {
	case "interrupt":
		if err := domain.tasks.Interrupt(ctx, finding.Claim); err != nil {
			return err
		}
	case "block":
		if finding.Task != "" {
			if err := domain.tasks.Block(ctx, finding.Task); err != nil {
				return err
			}
		}
	case "release":
		if err := domain.workspaces.ReleaseLease(ctx, finding.Workspace); err != nil {
			return err
		}
	}
	scope := event.Scope{Group: groupID, Task: finding.Task, Session: finding.Session}
	stream := event.Stream("group:" + groupID)
	if groupID == "" {
		stream = "engine:sentinel"
		if finding.Session != "" {
			stream = event.Stream("session:" + finding.Session)
		}
	}
	cause := event.ID("")
	if len(finding.Evidence) > 0 {
		cause = finding.Evidence[len(finding.Evidence)-1]
	}
	fact, err := domain.core.Bus.Publish(ctx, event.Event{Stream: stream, Scope: scope, Type: SentinelFlagged, Actor: event.Actor{Kind: "system"}, Cause: cause, Payload: body})
	if err != nil {
		return err
	}
	if groupID != "" {
		state, err := domain.groups.Get(ctx, groupID)
		if err != nil {
			return err
		}
		var to []event.ID
		if finding.Rule != "approval.timeout" {
			for _, member := range state.Members {
				if member.ID == finding.Member && member.Owner != "" {
					to = append(to, member.Owner)
				}
			}
		}
		if len(to) == 0 {
			for _, member := range state.Members {
				if member.Can(group.RoleOwner) {
					to = append(to, member.ID)
				}
			}
		}
		kind := "sentinel"
		if finding.Rule == "approval.timeout" {
			kind = "blocked"
		}
		body, _ = json.Marshal(group.Notice{Kind: kind, Text: finding.Code, To: to})
		if _, err = domain.core.Bus.Publish(ctx, event.Event{Stream: stream, Scope: scope, Type: group.NoticeSent, Actor: fact.Actor, Cause: fact.ID, Payload: body}); err != nil {
			return err
		}
	}
	domain.sentinelSeen[key] = true
	return nil
}

func (domain *Coordinator) ApprovalTimedOut(ctx context.Context, scope event.Scope, member, request event.ID) {
	_ = domain.flagFinding(ctx, scope.Group, leader.Finding{Rule: "approval.timeout", Code: "MRK-6002", Task: scope.Task, Session: scope.Session, Member: member, Evidence: []event.ID{request}, Action: "block"})
}
