package config

import "maps"

// Merge overlays a project's configuration on the global configuration. A project may choose models, providers and
// MCP servers and permission rules for that project (they are already scoped to it); what grants trust or widens
// permissions everywhere (trust decisions, permission grants, network hosts, the cloud endpoint, personal rules) is read
// from the global file only.
func Merge(global, project Value) Value {
	merged := clone(global)
	for _, field := range []struct{ from, to *string }{
		{&project.Model, &merged.Model}, {&project.SmallModel, &merged.SmallModel}, {&project.DefaultAgent, &merged.DefaultAgent}, {&project.Thinking, &merged.Thinking},
		{&project.Locale, &merged.Locale}, {&project.Log, &merged.Log},
	} {
		if *field.from != "" {
			*field.to = *field.from
		}
	}
	for id, provider := range project.Providers {
		merged.Providers[id] = mergeProvider(merged.Providers[id], provider)
	}
	if len(project.MCPServers) > 0 {
		if merged.MCPServers == nil {
			merged.MCPServers = map[string]MCPServer{}
		}
		maps.Copy(merged.MCPServers, project.MCPServers)
	}
	if len(project.Agents) > 0 {
		merged.Agents = maps.Clone(merged.Agents)
		if merged.Agents == nil {
			merged.Agents = map[string]Agent{}
		}
		maps.Copy(merged.Agents, project.Agents)
	}
	merged.PermissionRules = append(merged.PermissionRules, project.PermissionRules...)
	merged.Warnings = append(merged.Warnings, project.Warnings...)
	return merged
}

func mergeProvider(base, over Provider) Provider {
	for _, field := range []struct{ from, to *string }{
		{&over.Name, &base.Name}, {&over.Protocol, &base.Protocol}, {&over.BaseURL, &base.BaseURL},
		{&over.APIKey, &base.APIKey}, {&over.Auth, &base.Auth}, {&over.Station, &base.Station}, {&over.Group, &base.Group},
	} {
		if *field.from != "" {
			*field.to = *field.from
		}
	}
	if over.Headers != nil {
		base.Headers = over.Headers
	}
	if over.Picker != nil {
		base.Picker = over.Picker
	}
	base.Disabled = base.Disabled || over.Disabled
	if len(over.Models) > 0 {
		models := maps.Clone(base.Models)
		if models == nil {
			models = map[string]Model{}
		}
		maps.Copy(models, over.Models)
		base.Models = models
	}
	return base
}
