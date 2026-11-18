package window

import (
	"bytes"
	"encoding/json"
)

// compactSchema drops `"additionalProperties": false` from a tool's input schema before the model sees it. Every
// tool refuses fields it does not know when it decodes its input, so the keyword adds nothing but tokens; the
// order of the other keys stays as the author wrote it. A schema that cannot be read is returned unchanged.
func compactSchema(schema json.RawMessage) json.RawMessage {
	compact, ok := dropClosedObjects(bytes.TrimSpace(schema))
	if !ok {
		return schema
	}
	return compact
}

func dropClosedObjects(raw []byte) ([]byte, bool) {
	if len(raw) == 0 {
		return nil, false
	}
	if raw[0] != '{' && raw[0] != '[' {
		return raw, true
	}
	decoder := json.NewDecoder(bytes.NewReader(raw))
	if _, err := decoder.Token(); err != nil {
		return nil, false
	}
	var out bytes.Buffer
	out.WriteByte(raw[0])
	first := true
	for decoder.More() {
		key := ""
		if raw[0] == '{' {
			token, err := decoder.Token()
			name, isString := token.(string)
			if err != nil || !isString {
				return nil, false
			}
			key = name
		}
		var value json.RawMessage
		if err := decoder.Decode(&value); err != nil {
			return nil, false
		}
		if key == "additionalProperties" && string(value) == "false" {
			continue
		}
		inner, ok := dropClosedObjects(value)
		if !ok {
			return nil, false
		}
		if !first {
			out.WriteByte(',')
		}
		first = false
		if raw[0] == '{' {
			name, _ := json.Marshal(key)
			out.Write(name)
			out.WriteByte(':')
		}
		out.Write(inner)
	}
	if raw[0] == '{' {
		out.WriteByte('}')
	} else {
		out.WriteByte(']')
	}
	return out.Bytes(), true
}
