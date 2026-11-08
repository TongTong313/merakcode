package leader

import (
	"encoding/json"
	"slices"
	"strings"

	"github.com/TongTong313/merakcode/merak/engine/event"
	"github.com/TongTong313/merakcode/merak/engine/task"
)

// EnvironmentTargets names each active root once when an external path touches its scope.
func EnvironmentTargets(fact event.Event, cards []task.Card) []event.ID {
	changes := environmentChanges(fact)
	parents := map[event.ID]event.ID{}
	for _, card := range cards {
		parents[card.ID] = card.Parent
	}
	rootOf := func(id event.ID) event.ID {
		for steps := 0; parents[id] != "" && steps < len(cards); steps++ {
			id = parents[id]
		}
		return id
	}
	owners := map[event.ID]event.ID{}
	for _, card := range cards {
		for _, claim := range card.Claims {
			owners[claim.ID] = rootOf(card.ID)
		}
	}
	var targets []event.ID
	for _, card := range cards {
		if card.Status != task.Running && card.Status != task.Queued && card.Status != task.Open {
			continue
		}
		var areas []string
		for _, claim := range card.Claims {
			if claim.Status == task.ClaimActive || claim.Status == task.ClaimQueued {
				areas = append(areas, claim.Scope...)
			}
		}
		if len(areas) == 0 {
			areas = card.Areas
		}
		matched := false
		root := rootOf(card.ID)
		for _, area := range areas {
			for _, change := range changes {
				if change.path == "" || owners[change.claim] == root {
					continue
				}
				name := change.path
				if matchesPaths(area, []string{name}) || !strings.ContainsAny(area, "*?[") && (area == "." || strings.HasPrefix(name, strings.TrimSuffix(area, "/")+"/")) {
					matched = true
				}
			}
		}
		if !matched {
			continue
		}
		if !slices.Contains(targets, root) {
			targets = append(targets, root)
		}
	}
	slices.Sort(targets)
	return targets
}

type environmentChange struct {
	path  string
	claim event.ID
}

func environmentChanges(fact event.Event) []environmentChange {
	var payload struct {
		Paths   []string            `json:"paths"`
		Claims  map[string]event.ID `json:"claims"`
		Commits []struct {
			ID    string   `json:"id"`
			Paths []string `json:"paths"`
		} `json:"commits"`
	}
	if json.Unmarshal(fact.Payload, &payload) != nil {
		return nil
	}
	if fact.Type != "file.changed" && fact.Type != "repo.changed" {
		payload.Claims = nil
	}
	var changes []environmentChange
	for _, name := range payload.Paths {
		changes = append(changes, environmentChange{path: name, claim: payload.Claims[name]})
	}
	for _, commit := range payload.Commits {
		if len(commit.Paths) == 0 {
			changes = append(changes, environmentChange{claim: payload.Claims[commit.ID]})
		}
		for _, name := range commit.Paths {
			changes = append(changes, environmentChange{path: name, claim: payload.Claims[commit.ID]})
		}
	}
	return changes
}

func EnvironmentHasExternal(fact event.Event) bool {
	changes := environmentChanges(fact)
	for _, change := range changes {
		if change.claim == "" {
			return true
		}
	}
	return len(changes) == 0
}
