package leader_test

import (
	"encoding/json"
	"testing"
	"time"

	"github.com/TongTong313/merakcode/merak/engine/event"
	"github.com/TongTong313/merakcode/merak/engine/leader"
)

func TestTriggersMatchEventTypesAndRecursivePathGlobs(t *testing.T) {
	for _, test := range []struct {
		name    string
		kind    event.Type
		payload string
		matched bool
	}{
		{"nested document", "file.changed", `{"paths":["docs/zh/guide.md"]}`, true},
		{"direct document", "file.changed", `{"paths":["docs/guide.md"]}`, true},
		{"commit paths", "repo.changed", `{"commits":[{"id":"commit","paths":["docs/guide.md"]}]}`, true},
		{"different extension", "file.changed", `{"paths":["docs/guide.txt"]}`, false},
		{"different directory", "file.changed", `{"paths":["src/guide.md"]}`, false},
		{"different event", "external.finished", `{"paths":["docs/guide.md"]}`, false},
	} {
		t.Run(test.name, func(t *testing.T) {
			rules, err := leader.NewTriggers([]leader.Trigger{{ID: "docs", When: event.Filter{Types: []event.Type{"file.changed", "repo.changed"}}, Where: "docs/**/*.md", Then: leader.Action{Kind: leader.CreateTask, Template: "Sync English docs", Member: "writer"}}})
			if err != nil {
				t.Fatal(err)
			}
			actions, handled := rules.Evaluate(event.Event{Type: test.kind, Scope: event.Scope{Group: "group"}, Payload: json.RawMessage(test.payload)}, time.Unix(0, 0))
			if handled != test.matched || (len(actions) == 1) != test.matched {
				t.Fatalf("actions=%+v handled=%v", actions, handled)
			}
			if test.matched && (actions[0].Rule != "docs" || actions[0].Action.Template != "Sync English docs" || actions[0].Action.Member != "writer") {
				t.Fatalf("action=%+v", actions[0])
			}
		})
	}
}

func TestTriggersSuppressRepeatedWorkWithinTheSameGroupAndTaskCooldown(t *testing.T) {
	rules, err := leader.NewTriggers([]leader.Trigger{{ID: "docs", When: event.Filter{Types: []event.Type{"file.changed", "repo.changed"}}, Then: leader.Action{Kind: leader.CreateTask, Template: "Sync docs"}, Cooldown: time.Minute}})
	if err != nil {
		t.Fatal(err)
	}
	start := time.Unix(1000, 0)
	for _, test := range []struct {
		name, group, task string
		offset            time.Duration
		count             int
	}{
		{"first event", "group", "task", 0, 1},
		{"same task", "group", "task", 59 * time.Second, 0},
		{"other task", "group", "other", 59 * time.Second, 1},
		{"other group", "other", "task", 59 * time.Second, 1},
		{"window elapsed", "group", "task", time.Minute, 1},
	} {
		t.Run(test.name, func(t *testing.T) {
			actions, handled := rules.Evaluate(event.Event{Type: "file.changed", Scope: event.Scope{Group: event.ID(test.group), Task: event.ID(test.task)}, Payload: json.RawMessage(`{}`)}, start.Add(test.offset))
			if !handled || len(actions) != test.count {
				t.Fatalf("handled=%v actions=%+v", handled, actions)
			}
		})
	}
}

func TestTriggersRejectInvalidRulesBeforeTheyCanRun(t *testing.T) {
	valid := leader.Trigger{ID: "docs", When: event.Filter{Types: []event.Type{"file.changed"}}, Then: leader.Action{Kind: leader.CreateTask, Template: "Sync docs"}}
	for _, test := range []struct {
		name   string
		change func(*leader.Trigger)
	}{
		{"missing id", func(rule *leader.Trigger) { rule.ID = "" }},
		{"missing event types", func(rule *leader.Trigger) { rule.When.Types = nil }},
		{"invalid glob", func(rule *leader.Trigger) { rule.Where = "docs/[" }},
		{"negative cooldown", func(rule *leader.Trigger) { rule.Cooldown = -time.Second }},
		{"unknown action", func(rule *leader.Trigger) { rule.Then.Kind = "execute_shell" }},
		{"empty task template", func(rule *leader.Trigger) { rule.Then.Template = "" }},
		{"missing assignee", func(rule *leader.Trigger) { rule.Then = leader.Action{Kind: leader.AssignMember} }},
		{"invalid priority", func(rule *leader.Trigger) { rule.Then = leader.Action{Kind: leader.WakeLeader, Priority: 4} }},
	} {
		t.Run(test.name, func(t *testing.T) {
			rule := valid
			test.change(&rule)
			if _, err := leader.NewTriggers([]leader.Trigger{rule}); err == nil {
				t.Fatal("invalid rule accepted")
			}
		})
	}
	if _, err := leader.NewTriggers([]leader.Trigger{valid, valid}); err == nil {
		t.Fatal("duplicate rule ids accepted")
	}
}

func TestDefaultConflictRulesCreateAnIntegrationAndInformTheLeader(t *testing.T) {
	rules, err := leader.NewTriggers(leader.DefaultTriggers())
	if err != nil {
		t.Fatal(err)
	}
	actions, handled := rules.Evaluate(event.Event{Type: "merge.conflicted", Scope: event.Scope{Group: "group", Task: "task"}}, time.Unix(0, 0))
	if !handled || len(actions) != 2 {
		t.Fatalf("conflict actions=%+v", actions)
	}
	if actions[0].Rule != leader.IntegrationTrigger || actions[0].Action.Kind != leader.CreateTask || actions[1].Action.Kind != leader.WakeLeader || actions[1].Action.Priority != leader.PriorityHigh {
		t.Fatalf("conflict actions=%+v", actions)
	}
}

func TestTriggerUpdatesPreserveCooldownAndOwnTheirConfiguration(t *testing.T) {
	configured := []leader.Trigger{{ID: "docs", When: event.Filter{Types: []event.Type{"file.changed"}}, Then: leader.Action{Kind: leader.NotifyHuman, Template: "Changed"}, Cooldown: time.Minute}}
	rules, err := leader.NewTriggers(configured)
	if err != nil {
		t.Fatal(err)
	}
	configured[0].When.Types[0] = "external.other"
	configured[0].Then.Template = "Mutated"
	fact := event.Event{Type: "file.changed", Scope: event.Scope{Group: "group"}}
	start := time.Unix(1000, 0)
	actions, handled := rules.Evaluate(fact, start)
	if !handled || len(actions) != 1 || actions[0].Action.Template != "Changed" {
		t.Fatalf("caller changed rules: %+v", actions)
	}
	configured[0].When.Types[0] = "file.changed"
	if err := rules.Update(configured); err != nil {
		t.Fatal(err)
	}
	configured[0].When.Types[0] = "external.other"
	if actions, handled := rules.Evaluate(fact, start.Add(time.Second)); !handled || len(actions) != 0 {
		t.Fatalf("update reset cooldown: %+v", actions)
	}
	if actions, handled := rules.Evaluate(fact, start.Add(time.Minute)); !handled || len(actions) != 1 || actions[0].Action.Template != "Mutated" {
		t.Fatalf("updated rule=%+v", actions)
	}
}
