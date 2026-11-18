package secret

import (
	"bytes"
	"encoding/json"
	"strings"
)

// RedactJSON scans string values without changing field types or number precision.
func RedactJSON(body []byte) ([]byte, error) {
	if len(body) == 0 {
		return body, nil
	}
	var value any
	decoder := json.NewDecoder(bytes.NewReader(body))
	decoder.UseNumber()
	if err := decoder.Decode(&value); err != nil {
		return nil, err
	}
	value, changed := redactStrings(value)
	if !changed {
		return body, nil
	}
	return json.Marshal(value)
}

func redactStrings(value any) (any, bool) {
	changed := false
	switch item := value.(type) {
	case string:
		clean := Redact(item)
		return clean, clean != item
	case map[string]any:
		for key, child := range item {
			// "key" is also the identifier of documents and Leader threads.
			if !strings.EqualFold(key, "key") && SensitiveKey(key) {
				names, namesOnly := child.([]any)
				namesOnly = namesOnly && (strings.EqualFold(key, "env") || strings.EqualFold(key, "environment"))
				for _, name := range names {
					if _, ok := name.(string); !ok {
						namesOnly = false
						break
					}
				}
				if !namesOnly {
					item[key] = redactField(child)
					changed = true
					continue
				}
			}
			clean, updated := redactStrings(child)
			item[key], changed = clean, changed || updated
		}
	case []any:
		for i, child := range item {
			clean, updated := redactStrings(child)
			item[i], changed = clean, changed || updated
		}
	}
	return value, changed
}

func redactField(value any) any {
	switch item := value.(type) {
	case string:
		if item != "" {
			return "[redacted]"
		}
	case map[string]any:
		for key, child := range item {
			item[key] = redactField(child)
		}
	case []any:
		for i, child := range item {
			item[i] = redactField(child)
		}
	}
	return value
}
