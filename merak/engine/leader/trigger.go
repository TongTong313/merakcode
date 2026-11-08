package leader

import (
	"encoding/json"
	"slices"
	"time"

	"github.com/TongTong313/merakcode/merak/engine/event"
	"github.com/TongTong313/merakcode/merak/engine/group"
	"github.com/TongTong313/merakcode/merak/internal/platform/pathglob"
)

type Trigger = group.Trigger
type Action = group.Action
type ActionKind = group.ActionKind

const (
	CreateTask   = group.CreateTask
	NotifyHuman  = group.NotifyHuman
	WakeLeader   = group.WakeLeader
	AssignMember = group.AssignMember
)

const IntegrationTrigger event.ID = "default.merge.integration"

func DefaultTriggers() []Trigger {
	return []Trigger{
		{ID: IntegrationTrigger, When: event.Filter{Types: []event.Type{"merge.conflicted"}}, Then: Action{Kind: CreateTask, Template: "Resolve the integration conflict"}},
		{ID: "default.merge.awareness", When: event.Filter{Types: []event.Type{"merge.conflicted"}}, Then: Action{Kind: WakeLeader, Priority: PriorityHigh}},
	}
}

type Triggered struct {
	Rule   event.ID
	Action Action
}

type Triggers struct {
	rules []Trigger
	last  map[triggerKey]time.Time
}

type triggerKey struct{ rule, group, task event.ID }

func NewTriggers(rules []Trigger) (*Triggers, error) {
	t := &Triggers{last: make(map[triggerKey]time.Time)}
	if err := t.Update(rules); err != nil {
		return nil, err
	}
	return t, nil
}

func (t *Triggers) Update(rules []Trigger) error {
	if err := group.ValidateTriggers(rules); err != nil {
		return err
	}
	cloned := slices.Clone(rules)
	ids := map[event.ID]bool{}
	for index := range cloned {
		cloned[index].When.Types = slices.Clone(cloned[index].When.Types)
		cloned[index].When.Streams = slices.Clone(cloned[index].When.Streams)
		ids[cloned[index].ID] = true
	}
	for key := range t.last {
		if !ids[key.rule] {
			delete(t.last, key)
		}
	}
	t.rules = cloned
	return nil
}

func (t *Triggers) Evaluate(fact event.Event, now time.Time) ([]Triggered, bool) {
	var actions []Triggered
	handled := false
	for _, rule := range t.rules {
		if !rule.When.Matches(fact) {
			continue
		}
		if rule.Where != "" && !matchesPaths(rule.Where, eventPaths(fact)) {
			continue
		}
		handled = true
		key := triggerKey{rule: rule.ID, group: fact.Scope.Group, task: fact.Scope.Task}
		if last, ok := t.last[key]; ok && rule.Cooldown > 0 && now.Sub(last) < rule.Cooldown {
			continue
		}
		t.last[key] = now
		actions = append(actions, Triggered{Rule: rule.ID, Action: rule.Then})
	}
	return actions, handled
}

func eventPaths(fact event.Event) []string {
	var payload struct {
		Paths   []string `json:"paths"`
		Commits []struct {
			Paths []string `json:"paths"`
		} `json:"commits"`
	}
	if json.Unmarshal(fact.Payload, &payload) != nil {
		return nil
	}
	paths := payload.Paths
	for _, commit := range payload.Commits {
		paths = append(paths, commit.Paths...)
	}
	return paths
}

func matchesPaths(pattern string, paths []string) bool {
	compiled, err := pathglob.Compile(pattern)
	if err != nil {
		return false
	}
	for _, name := range paths {
		if compiled.Match(name) {
			return true
		}
	}
	return false
}
