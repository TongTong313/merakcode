package conversation

import (
	"github.com/TongTong313/merakcode/merak/engine/agent/definition"
)

// applyDefaultAgent gives a conversation that names no agent the agent the configuration makes the default: the one
// default_agent names, else the build agent. What the client chose in options stays.
func (domain *Manager) applyDefaultAgent(options *SessionOptions) {
	settings := domain.registry.AgentConfiguration()
	if settings == nil {
		return
	}
	name := settings.Default
	if name == "" {
		name = "build"
	}
	chosen := domain.registry.BuiltinAgents()[0]
	if name != "build" && name != chosen.Name {
		found, ok := domain.registry.AgentNamed(name, options.Workdir)
		if !ok {
			return
		}
		chosen = found
	}
	UseAgent(options, chosen)
}

// UseAgent starts a conversation as an agent that is not saved in the library: its model, prompt, mode and tools
// apply where the options say nothing.
func UseAgent(options *SessionOptions, chosen definition.Agent) {
	if options.Provider == "" && chosen.Model.Provider != "" {
		options.Provider, options.Model, options.Thinking = chosen.Model.Provider, chosen.Model.Model, chosen.Model.Thinking
	}
	options.System += chosen.System
	if options.Mode == "" {
		options.Mode = chosen.Mode
	}
	if len(chosen.Tools) > 0 && len(options.Tools) == 0 {
		options.Tools = chosen.Tools
	}
	options.Switches = chosen.Switches
}
