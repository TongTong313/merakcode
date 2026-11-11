package config

import (
	"encoding/json"
	"maps"
	"slices"
)

// Agent is one entry of the v0.3 agent section. The names build, general, explore, title, summary, compaction and
// memory-extractor are built-in agents or internal jobs; any other name is an agent of its own.
type Agent struct {
	Description string `json:"description,omitempty"`
	// Model is "provider/model"; empty keeps the model the agent would have had.
	Model string `json:"model,omitempty"`
	// Prompt is the system prompt the agent gets in place of its own.
	Prompt string `json:"prompt,omitempty"`
	// Tools switches tools off or on by name for this agent; a name may end in *.
	Tools map[string]bool `json:"tools,omitempty"`
	// Disabled removes a built-in agent or an agent of the configuration.
	Disabled bool `json:"disabled,omitempty"`
}

// parseAgents reads the agent section. An entry that is not an object, the plan agent (there is no planning mode
// any more) and keys that v1 does not use are returned as warnings.
func parseAgents(raw map[string]json.RawMessage) (map[string]Agent, []string) {
	var warnings []string
	agents := map[string]Agent{}
	for _, name := range slices.Sorted(maps.Keys(raw)) {
		var fields map[string]json.RawMessage
		if json.Unmarshal(raw[name], &fields) != nil || fields == nil {
			warnings = append(warnings, "agent."+name+": an agent is an object, skipped")
			continue
		}
		if name == "plan" {
			warnings = append(warnings, "agent.plan: there is no planning mode any more, ignored")
			continue
		}
		var entry Agent
		valid := true
		for _, key := range slices.Sorted(maps.Keys(fields)) {
			var err error
			switch key {
			case "description":
				err = json.Unmarshal(fields[key], &entry.Description)
			case "model":
				err = json.Unmarshal(fields[key], &entry.Model)
			case "prompt":
				err = json.Unmarshal(fields[key], &entry.Prompt)
			case "tools":
				err = json.Unmarshal(fields[key], &entry.Tools)
			case "disable":
				err = json.Unmarshal(fields[key], &entry.Disabled)
			default:
				warnings = append(warnings, "agent."+name+"."+key+": this key is not used and is ignored")
			}
			if err != nil {
				warnings = append(warnings, "agent."+name+"."+key+": invalid value, skipped")
				valid = false
			}
		}
		if valid {
			agents[name] = entry
		}
	}
	return agents, warnings
}
