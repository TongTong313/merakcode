package leader

import (
	"encoding/json"
	"strings"
	"time"

	"github.com/TongTong313/merakcode/merak/engine/event"
	"github.com/TongTong313/merakcode/merak/engine/model"
	"github.com/TongTong313/merakcode/merak/engine/session"
	"github.com/TongTong313/merakcode/merak/engine/tool"
	"github.com/TongTong313/merakcode/merak/engine/workspace"
)

type Finding struct {
	Directory string        `json:"directory,omitempty"`
	Files     int           `json:"files,omitempty"`
	Duration  time.Duration `json:"duration,omitempty"`
	Rule      string        `json:"rule"`
	Code      string        `json:"code"`
	Claim     event.ID      `json:"claim,omitempty"`
	Member    event.ID      `json:"member,omitempty"`
	Task      event.ID      `json:"task,omitempty"`
	Session   event.ID      `json:"session,omitempty"`
	Workspace event.ID      `json:"workspace,omitempty"`
	Evidence  []event.ID    `json:"evidence,omitempty"`
	Action    string        `json:"action"`
}

type ClaimView struct {
	Claim, Task, Member, Session event.ID
	Active, Running, Preparing   bool
	Started, LastActivity        time.Time
	LastEvent                    event.ID
	MaxTokens                    int
	MaxCost                      float64
	Events                       []event.Event
}
type LeaseView struct {
	Workspace workspace.Workspace
	Ended     bool
}
type WatchView struct {
	Duration time.Duration
	Files    int
}
type SentinelView struct {
	Now    time.Time
	Claims []ClaimView
	Leases []LeaseView
	Watch  []WatchView
}

func Inspect(view SentinelView) []Finding {
	var found []Finding
	for _, claim := range view.Claims {
		if !claim.Active {
			continue
		}
		base := Finding{Code: "MRK-6002", Claim: claim.Claim, Task: claim.Task, Member: claim.Member, Session: claim.Session, Action: "notify"}
		add := func(rule, action string, evidence []event.ID) {
			value := base
			value.Rule, value.Action, value.Evidence = rule, action, evidence
			found = append(found, value)
		}
		if !claim.LastActivity.IsZero() && view.Now.Sub(claim.LastActivity) > 15*time.Minute {
			add("claim.idle", "notify", []event.ID{claim.LastEvent})
		}
		if !claim.Running && !claim.Preparing && !claim.Started.IsZero() && view.Now.Sub(claim.Started) > time.Second {
			add("claim.exited", "interrupt", []event.ID{claim.LastEvent})
		}
		if evidence := loopEvidence(claim.Events); len(evidence) > 0 {
			add("session.loop", "notify", evidence)
		}
		if !claim.Started.IsZero() {
			tokens := 0
			costs := make(map[string]float64)
			var evidence []event.ID
			for _, fact := range claim.Events {
				if fact.Type != session.MessageCompleted || !fact.Time.IsZero() && (fact.Time.Before(claim.Started) || fact.Time.After(claim.Started.Add(5*time.Minute))) {
					continue
				}
				value, err := event.Decode[session.Completion](fact)
				if err != nil {
					continue
				}
				tokens += value.Usage.Input + value.Usage.Output
				if value.Usage.CostKnown && value.Usage.Currency != "" {
					costs[value.Usage.Currency] += value.Usage.Cost
				}
				evidence = append(evidence, fact.ID)
			}
			exceeded := claim.MaxTokens > 0 && float64(tokens) > float64(claim.MaxTokens)/2
			if len(costs) == 1 && claim.MaxCost > 0 {
				for _, cost := range costs {
					exceeded = exceeded || cost > claim.MaxCost/2
				}
			}
			if exceeded {
				add("claim.budget", "notify", evidence)
			}
		}
	}
	for _, lease := range view.Leases {
		ws := lease.Workspace
		if ws.Kind == workspace.KindInplace && ws.Active && lease.Ended {
			found = append(found, Finding{Rule: "workspace.lease", Code: "MRK-6002", Task: ws.Task, Claim: ws.Claim, Member: ws.Member, Workspace: ws.ID, Action: "release"})
		}
	}
	for _, scan := range view.Watch {
		if scan.Duration > time.Second || scan.Files > 50000 {
			found = append(found, Finding{Rule: "watch.overload", Code: "MRK-1005", Action: "notify"})
		}
	}
	return found
}

func loopEvidence(facts []event.Event) []event.ID {
	last := ""
	var repeated, stagnant []event.ID
	seen := make(map[string]bool)
	for _, fact := range facts {
		if fact.Type == "file.changed" || fact.Type == "repo.changed" {
			stagnant = nil
			continue
		}
		if fact.Type == tool.Completed {
			result, err := event.Decode[tool.Completion](fact)
			if err == nil && !result.IsError {
				switch strings.ToLower(result.Name) {
				case "write_file", "edit_file", "write", "edit", "multiedit", "apply_patch", "filechange", "codex.file_change":
					stagnant = nil
				}
			}
			continue
		}
		if fact.Type != tool.Called {
			continue
		}
		call, err := event.Decode[model.ToolCall](fact)
		if err != nil {
			continue
		}
		input := call.Input
		var value any
		if json.Unmarshal(input, &value) == nil {
			input, _ = json.Marshal(value)
		}
		key := call.Name + "\x00" + string(input)
		if key != last {
			repeated = nil
			last = key
		}
		repeated = append(repeated, fact.ID)
		if !seen[call.Name] {
			seen[call.Name] = true
			stagnant = nil
		} else {
			stagnant = append(stagnant, fact.ID)
		}
	}
	if len(repeated) >= 3 {
		return repeated[len(repeated)-3:]
	}
	if len(stagnant) >= 10 {
		return stagnant[len(stagnant)-10:]
	}
	return nil
}
