package config

import (
	"bytes"
	"encoding/json"
	"errors"
	"maps"
	"slices"
	"strings"
)

// The `lsp` and `formatter` sections of a v0.3 file are configurable in v1 but the engine does not read them: it
// starts no language server and formats nothing. They are kept so that the settings can show them, and so that a
// file written for v0.3 keeps working if v1 ever runs them.

// LSPServer is one entry of the `lsp` section: `{ "disabled": true }` switches a built-in server off, anything else
// defines a server of the user. The JSON names are the ones of the file.
type LSPServer struct {
	Disabled       bool              `json:"disabled,omitempty"`
	Command        []string          `json:"command,omitempty"`
	Extensions     []string          `json:"extensions,omitempty"`
	Env            map[string]string `json:"env,omitempty"`
	Initialization json.RawMessage   `json:"initialization,omitempty"`
}

// LSP is the `lsp` section. Disabled is the file's `false`.
type LSP struct {
	Disabled bool                 `json:"disabled"`
	Servers  map[string]LSPServer `json:"servers,omitempty"`
}

// FormatterEntry is one entry of the `formatter` section. The JSON names are the ones of the file.
type FormatterEntry struct {
	Disabled    bool              `json:"disabled,omitempty"`
	Command     []string          `json:"command,omitempty"`
	Extensions  []string          `json:"extensions,omitempty"`
	Environment map[string]string `json:"environment,omitempty"`
}

// Formatter is the `formatter` section. Disabled is the file's `false`.
type Formatter struct {
	Disabled bool                      `json:"disabled"`
	Entries  map[string]FormatterEntry `json:"entries,omitempty"`
}

// LSPPatch changes the `lsp` section: Disabled true writes `false` and drops the entries, Servers replaces entries
// whole and a nil entry deletes one.
type LSPPatch struct {
	Disabled *bool                 `json:"disabled,omitempty"`
	Servers  map[string]*LSPServer `json:"servers,omitempty"`
}

// FormatterPatch changes the `formatter` section the way LSPPatch changes `lsp`.
type FormatterPatch struct {
	Disabled *bool                      `json:"disabled,omitempty"`
	Entries  map[string]*FormatterEntry `json:"entries,omitempty"`
}

// readSection reads a section that is `false`, `true` or an object of entries. A missing section or `null` is the
// same as `true`.
func readSection(name string, raw json.RawMessage) (disabled bool, entries map[string]json.RawMessage, err error) {
	trimmed := bytes.TrimSpace(raw)
	switch {
	case len(trimmed) == 0 || string(trimmed) == "null" || string(trimmed) == "true":
		return false, nil, nil
	case string(trimmed) == "false":
		return true, nil, nil
	case trimmed[0] == '{':
		if json.Unmarshal(trimmed, &entries) != nil {
			return false, nil, errors.New("invalid " + name)
		}
		return false, entries, nil
	}
	return false, nil, errors.New("invalid " + name)
}

// readEntries decodes the entries of a section. An entry that is not an object, or whose known fields have the wrong
// type, is reported in the warnings and left out; the file keeps it.
func readEntries[T any](value *Value, section string, entries map[string]json.RawMessage) map[string]T {
	var result map[string]T
	for _, id := range slices.Sorted(maps.Keys(entries)) {
		raw := bytes.TrimSpace(entries[id])
		var entry T
		if len(raw) == 0 || raw[0] != '{' || json.Unmarshal(raw, &entry) != nil {
			value.warn(section + "." + id + ": this entry is not valid and is skipped")
			continue
		}
		if result == nil {
			result = map[string]T{}
		}
		result[id] = entry
	}
	return result
}

// readTooling fills the lsp and formatter sections of a value from the file.
func readTooling(value *Value, top map[string]json.RawMessage) error {
	disabled, entries, err := readSection("lsp", top["lsp"])
	if err != nil {
		return err
	}
	value.LSP = LSP{Disabled: disabled, Servers: readEntries[LSPServer](value, "lsp", entries)}
	disabled, entries, err = readSection("formatter", top["formatter"])
	if err != nil {
		return err
	}
	value.Formatter = Formatter{Disabled: disabled, Entries: readEntries[FormatterEntry](value, "formatter", entries)}
	return nil
}

// hideToolingSecrets empties the environment values of a value, keeping the names, as it does for MCP servers.
func hideToolingSecrets(value *Value) {
	for _, server := range value.LSP.Servers {
		for name := range server.Env {
			server.Env[name] = ""
		}
	}
	for _, entry := range value.Formatter.Entries {
		for name := range entry.Environment {
			entry.Environment[name] = ""
		}
	}
}

// validateToolingEntry checks the parts of an entry that a client may get wrong. The name and the command are
// checked for every entry; extensions need a dot and at least one more character.
func validateToolingEntry(section, name string, command, extensions []string) error {
	if strings.TrimSpace(name) == "" {
		return errors.New("invalid " + section + " name")
	}
	for _, part := range command {
		if strings.TrimSpace(part) == "" {
			return errors.New("invalid " + section + " command")
		}
	}
	for _, extension := range extensions {
		if len(extension) < 2 || extension[0] != '.' {
			return errors.New("invalid " + section + " extension")
		}
	}
	return nil
}

// keepHidden gives the entries that come back from the public view their hidden values again: an empty value of a
// name that the file already has means "keep what is there".
func keepHidden(env, current map[string]string) map[string]string {
	if env == nil {
		return nil
	}
	kept := make(map[string]string, len(env))
	for name, value := range env {
		if old, ok := current[name]; ok && value == "" {
			value = old
		}
		kept[name] = value
	}
	return kept
}

// sectionEdits turns a change to a section into edits of the file. A section that is switched on and off
// again comes back as an object. check returns an error for an entry that cannot be written, restore puts the hidden
// values of the current entry into the new one.
func sectionEdits[T any](key string, off bool, known map[string]T, disabled *bool, entries map[string]*T, check func(name string, entry *T) error, restore func(entry *T, current T)) ([]edit, error) {
	names := slices.Sorted(maps.Keys(entries))
	for _, name := range names {
		if err := check(name, entries[name]); err != nil {
			return nil, err
		}
	}
	if disabled != nil && *disabled {
		return []edit{{path: []string{key}, value: false}}, nil
	}
	var edits []edit
	if off && (disabled != nil || len(entries) > 0) {
		edits = append(edits, edit{path: []string{key}, value: map[string]any{}})
	}
	for _, name := range names {
		if entries[name] == nil {
			edits = append(edits, edit{path: []string{key, name}, clear: true})
			continue
		}
		entry := *entries[name]
		restore(&entry, known[name])
		edits = append(edits, edit{path: []string{key, name}, value: entry})
	}
	return edits, nil
}

func lspEdits(current LSP, patch LSPPatch) ([]edit, error) {
	return sectionEdits("lsp", current.Disabled, current.Servers, patch.Disabled, patch.Servers,
		func(name string, entry *LSPServer) error {
			if entry == nil {
				return validateToolingEntry("lsp", name, nil, nil)
			}
			return validateToolingEntry("lsp", name, entry.Command, entry.Extensions)
		},
		func(entry *LSPServer, old LSPServer) { entry.Env = keepHidden(entry.Env, old.Env) })
}

func formatterEdits(current Formatter, patch FormatterPatch) ([]edit, error) {
	return sectionEdits("formatter", current.Disabled, current.Entries, patch.Disabled, patch.Entries,
		func(name string, entry *FormatterEntry) error {
			if entry == nil {
				return validateToolingEntry("formatter", name, nil, nil)
			}
			return validateToolingEntry("formatter", name, entry.Command, entry.Extensions)
		},
		func(entry *FormatterEntry, old FormatterEntry) {
			entry.Environment = keepHidden(entry.Environment, old.Environment)
		})
}

// mergeTooling lays the lsp and formatter sections of a project over the global ones: an entry of the project
// replaces the global entry of the same name whole, and a project that switches a section off switches it off for the
// merged value only.
func mergeTooling(merged *Value, project Value) {
	merged.LSP.Disabled = merged.LSP.Disabled || project.LSP.Disabled
	if len(project.LSP.Servers) > 0 {
		merged.LSP.Servers = maps.Clone(merged.LSP.Servers)
		if merged.LSP.Servers == nil {
			merged.LSP.Servers = map[string]LSPServer{}
		}
		maps.Copy(merged.LSP.Servers, project.LSP.Servers)
	}
	merged.Formatter.Disabled = merged.Formatter.Disabled || project.Formatter.Disabled
	if len(project.Formatter.Entries) > 0 {
		merged.Formatter.Entries = maps.Clone(merged.Formatter.Entries)
		if merged.Formatter.Entries == nil {
			merged.Formatter.Entries = map[string]FormatterEntry{}
		}
		maps.Copy(merged.Formatter.Entries, project.Formatter.Entries)
	}
}
