package config

import "encoding/json"

// ParseKeys returns the raw values of the named top-level keys without interpreting them.
func ParseKeys(data []byte, names ...string) (map[string]json.RawMessage, error) {
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
