package config

import (
	"reflect"
	"slices"
	"sort"
)

// providerProtocols maps the protocol names v1 uses to the package names a v0.3 file uses.
var providerProtocols = map[string]string{"openai": "@ai-sdk/openai-compatible", "anthropic": "@ai-sdk/anthropic"}

// providerEdits turns the change to one provider into changes of the v0.3 file. current is the provider as the file
// has it now. Fields the patch does not name are not touched.
func providerEdits(current Provider, id string, patch ProviderPatch) []edit {
	base := []string{"provider", id}
	at := func(path ...string) []string { return append(slices.Clone(base), path...) }
	var edits []edit
	text := func(path []string, value *string) {
		if value == nil {
			return
		}
		if *value == "" {
			edits = append(edits, edit{path: path, clear: true})
			return
		}
		edits = append(edits, edit{path: path, value: *value})
	}
	text(at("name"), patch.Name)
	if patch.Protocol != nil {
		npm := providerProtocols[*patch.Protocol]
		text(at("npm"), &npm)
	}
	text(at("options", "baseURL"), patch.BaseURL)
	text(at("options", "apiKey"), patch.APIKey)
	if patch.Auth != nil {
		if current.Station != "" {
			text(at("relay", "auth"), patch.Auth)
		} else {
			text(at("options", "auth"), patch.Auth)
		}
	}
	if patch.Station != nil || patch.Group != nil {
		text(at("relay", "station"), patch.Station)
		text(at("relay", "group"), patch.Group)
		if current.Station == "" && patch.Station != nil && *patch.Station != "" {
			kind := "standard"
			text(at("relay", "kind"), &kind)
		}
	}
	switch {
	case patch.ClearHeaders:
		edits = append(edits, edit{path: at("options", "headers"), clear: true})
	case patch.Headers != nil:
		edits = append(edits, edit{path: at("options", "headers"), value: patch.Headers})
	}
	if patch.Picker != nil {
		if len(patch.Picker.Include) == 0 && len(patch.Picker.Exclude) == 0 {
			edits = append(edits, edit{path: at("picker"), clear: true})
		} else {
			edits = append(edits, edit{path: at("picker"), value: patch.Picker})
		}
	}
	ids := make([]string, 0, len(patch.Models))
	for model := range patch.Models {
		ids = append(ids, model)
	}
	sort.Strings(ids)
	for _, model := range ids {
		if known, ok := current.Models[model]; ok && patch.Models[model] != nil && reflect.DeepEqual(known, *patch.Models[model]) {
			continue
		}
		edits = append(edits, modelEdits(at("models", model), patch.Models[model])...)
	}
	return edits
}

func modelEdits(path []string, model *Model) []edit {
	if model == nil {
		return []edit{{path: path, clear: true}}
	}
	at := func(more ...string) []string { return append(slices.Clone(path), more...) }
	var edits []edit
	number := func(path []string, value int) {
		if value == 0 {
			edits = append(edits, edit{path: path, clear: true})
			return
		}
		edits = append(edits, edit{path: path, value: value})
	}
	if model.Name == "" {
		edits = append(edits, edit{path: at("name"), clear: true})
	} else {
		edits = append(edits, edit{path: at("name"), value: model.Name})
	}
	number(at("limit", "context"), model.Window)
	number(at("limit", "output"), model.MaxOutput)
	if model.Thinking != nil {
		variants := map[string]struct{}{}
		for _, level := range model.Thinking {
			variants[level] = struct{}{}
		}
		edits = append(edits, edit{path: at("variants"), value: variants})
	}
	return edits
}

// disabledEdit rewrites disabled_providers after a provider is switched on or off or removed.
func disabledEdit(value Value, id string, disabled bool) edit {
	var ids []string
	for known, provider := range value.Providers {
		if provider.Disabled && known != id {
			ids = append(ids, known)
		}
	}
	if disabled {
		ids = append(ids, id)
	}
	sort.Strings(ids)
	return setList("disabled_providers", ids)
}
