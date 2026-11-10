package engine

import (
	"context"
	"encoding/json"
	"slices"
	"time"

	"github.com/TongTong313/merakcode/merak/engine/event"
	"github.com/TongTong313/merakcode/merak/engine/group"
	"github.com/TongTong313/merakcode/merak/engine/leader"
	"github.com/TongTong313/merakcode/merak/engine/loop"
	"github.com/TongTong313/merakcode/merak/engine/session"
	"github.com/TongTong313/merakcode/merak/engine/store"
	"github.com/TongTong313/merakcode/merak/engine/task"
)

func (e *Engine) watchSentinel(every time.Duration) {
	if every <= 0 {
		every = time.Minute
	}
	filter := event.Filter{Types: []event.Type{session.MessageDelta}}
	facts, stop := e.Bus.Subscribe(filter)
	e.workers.Go(func() {
		defer func() { stop() }()
		ticker := time.NewTicker(every)
		defer ticker.Stop()
		activity := make(map[event.ID]event.Event)
		for {
			select {
			case <-e.ctx.Done():
				return
			case fact, ok := <-facts:
				if !ok {
					stop()
					facts, stop = e.Bus.Subscribe(filter)
					continue
				}
				if fact.Scope.Session != "" && fact.Stream == event.Stream("session:"+fact.Scope.Session) {
					activity[fact.Scope.Session] = fact
				}
			case <-ticker.C:
				e.inspectClaims(e.ctx, activity)
			}
		}
	})
}

func (e *Engine) inspectClaims(ctx context.Context, activity map[event.ID]event.Event) {
	claimed := make(map[event.ID]bool)
	groups, err := e.store.Find(ctx, store.Query{Types: []event.Type{group.Created}})
	if err != nil {
		return
	}
	for _, created := range groups {
		cards, err := e.Tasks.List(ctx, created.Scope.Group)
		if err != nil {
			continue
		}
		state, decodeErr := event.Decode[group.State](created)
		_, hosted := e.hostedGroups.Load(created.Scope.Group)
		if decodeErr == nil && (state.Group.Kind == group.KindCloud || hosted) {
			for _, card := range cards {
				for _, claim := range card.Claims {
					claimed[claim.Session] = true
				}
			}
			continue
		}
		history, err := e.store.Find(ctx, store.Query{Scope: event.Scope{Group: created.Scope.Group}})
		if err != nil {
			continue
		}
		view := leader.SentinelView{Now: e.now()}
		statuses := make(map[event.ID]task.ClaimStatus)
		for _, card := range cards {
			for _, claim := range card.Claims {
				claimed[claim.Session] = true
				statuses[claim.ID] = claim.Status
				if claim.Status != task.ClaimActive {
					continue
				}
				c := leader.ClaimView{Claim: claim.ID, Task: card.ID, Member: claim.Member, Session: claim.Session, Active: true, MaxTokens: card.Budget.MaxTokens, MaxCost: card.Budget.MaxCost}
				e.mu.Lock()
				_, c.Running = e.claimRuns[claim.ID]
				_, c.Preparing = e.claimPreparing[claim.ID]
				e.mu.Unlock()
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
			_ = e.flagFinding(ctx, created.Scope.Group, finding)
		}
		// Re-read after interruptions so stale leases can be released in the same patrol.
		cards, err = e.Tasks.List(ctx, created.Scope.Group)
		if err != nil {
			continue
		}
		for _, card := range cards {
			for _, claim := range card.Claims {
				statuses[claim.ID] = claim.Status
			}
		}
		docs, err := e.store.List(ctx, "workspace", "")
		if err != nil {
			continue
		}
		leases := leader.SentinelView{Now: e.now()}
		for _, doc := range docs {
			ws, err := e.Workspaces.Get(ctx, event.ID(doc.Key))
			if err != nil || ws.Group != created.Scope.Group {
				continue
			}
			status, known := statuses[ws.Claim]
			leases.Leases = append(leases.Leases, leader.LeaseView{Workspace: ws, Ended: known && status != task.ClaimActive && status != task.ClaimQueued})
		}
		for _, finding := range leader.Inspect(leases) {
			_ = e.flagFinding(ctx, created.Scope.Group, finding)
		}
	}
	e.inspectSessions(ctx, claimed)
}

func (e *Engine) inspectSessions(ctx context.Context, claimed map[event.ID]bool) {
	created, err := e.store.Find(ctx, store.Query{Types: []event.Type{session.Created}})
	if err != nil {
		return
	}
	for _, fact := range created {
		if claimed[fact.Scope.Session] {
			continue
		}
		history, err := e.store.Read(ctx, fact.Stream, 1, 0)
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
		for _, finding := range leader.Inspect(leader.SentinelView{Now: e.now(), Claims: []leader.ClaimView{view}}) {
			_ = e.flagFinding(ctx, fact.Scope.Group, finding)
		}
	}
}

func (e *Engine) flagFinding(ctx context.Context, groupID event.ID, finding leader.Finding) error {
	e.sentinelMu.Lock()
	defer e.sentinelMu.Unlock()
	body, _ := json.Marshal(finding)
	key := string(groupID) + string(body)
	if finding.Rule == "claim.budget" {
		key = string(groupID) + "/claim.budget/" + string(finding.Claim)
	}
	if e.sentinelSeen[key] {
		return nil
	}
	switch finding.Action {
	case "interrupt":
		if err := e.Tasks.Interrupt(ctx, finding.Claim); err != nil {
			return err
		}
	case "block":
		if finding.Task != "" {
			if err := e.Tasks.Block(ctx, finding.Task); err != nil {
				return err
			}
		}
	case "release":
		if err := e.Workspaces.ReleaseLease(ctx, finding.Workspace); err != nil {
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
	fact, err := e.Bus.Publish(ctx, event.Event{Stream: stream, Scope: scope, Type: SentinelFlagged, Actor: event.Actor{Kind: "system"}, Cause: cause, Payload: body})
	if err != nil {
		return err
	}
	if groupID != "" {
		state, err := e.Groups.Get(ctx, groupID)
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
		if _, err = e.Bus.Publish(ctx, event.Event{Stream: stream, Scope: scope, Type: group.NoticeSent, Actor: fact.Actor, Cause: fact.ID, Payload: body}); err != nil {
			return err
		}
	}
	e.sentinelSeen[key] = true
	return nil
}

func (e *Engine) approvalTimedOut(ctx context.Context, scope event.Scope, member, request event.ID) {
	_ = e.flagFinding(ctx, scope.Group, leader.Finding{Rule: "approval.timeout", Code: "MRK-6002", Task: scope.Task, Session: scope.Session, Member: member, Evidence: []event.ID{request}, Action: "block"})
}
