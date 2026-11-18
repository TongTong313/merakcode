package config

import (
	"slices"
	"testing"
)

// schemaKeys are the top-level keys of schema/config.json in the v0.3.1 release.
var schemaKeys = []string{
	"$schema", "locale", "logLevel", "server", "command", "skills", "watcher", "plugin", "agentConnections",
	"collaboration", "snapshot", "disabled_providers", "enabled_providers", "model", "small_model", "default_agent",
	"mode", "agent", "provider", "mcp", "formatter", "lsp", "instructions", "rules", "layout", "permission", "tools",
	"enterprise", "compaction", "memory", "tool_discovery", "experimental", "ui", "plugin_options", "storage",
	"sandbox",
}

func TestKeysThatOnlyV1HasNeverShareANameWithAV03Key(t *testing.T) {
	if !slices.Equal(slices.Sorted(slices.Values(v03Keys)), slices.Sorted(slices.Values(schemaKeys))) {
		t.Fatalf("the list of v0.3 keys differs from the v0.3 schema: %v", v03Keys)
	}
	for _, key := range v1Keys {
		if slices.Contains(schemaKeys, key) {
			t.Errorf("%q is a v0.3 key; a v1 key must not reuse it", key)
		}
	}
}
