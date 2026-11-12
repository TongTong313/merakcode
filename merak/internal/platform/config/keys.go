package config

import (
	"encoding/json"
	"os"
	"path/filepath"
)

// ReadGlobalKeys returns the raw values of the named top-level keys of the global configuration file under a root
// directory: merakcode.jsonc, or merakcode.json when that is the file that exists. Keys that are not in the file are
// left out, and a missing file has none. It is for readers of keys that v1 keeps but does not interpret.
func ReadGlobalKeys(root string, names ...string) (map[string]json.RawMessage, error) {
	data, err := os.ReadFile(filepath.Join(root, "merakcode.jsonc"))
	if os.IsNotExist(err) {
		data, err = os.ReadFile(filepath.Join(root, "merakcode.json"))
	}
	if os.IsNotExist(err) {
		return map[string]json.RawMessage{}, nil
	}
	if err != nil {
		return nil, err
	}
	top, err := parseFile(data)
	if err != nil {
		return nil, err
	}
	keys := map[string]json.RawMessage{}
	for _, name := range names {
		if raw, ok := top[name]; ok {
			keys[name] = raw
		}
	}
	return keys, nil
}
