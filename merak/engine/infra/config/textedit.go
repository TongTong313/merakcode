package config

import (
	"bytes"
	"encoding/json"
	"errors"
	"strings"
)

// A change to one value of the configuration file is made on the text of the file itself, so comments, blank lines,
// the order of the keys and every other value stay as the user wrote them.

type member struct {
	key                        string
	keyStart, valStart, valEnd int
}

func isSpace(char byte) bool { return char == ' ' || char == '\t' || char == '\r' || char == '\n' }

func skipSpace(text []byte, i int) int {
	for i < len(text) && isSpace(text[i]) {
		i++
	}
	return i
}

// stringEnd returns the index after the string that starts at i.
func stringEnd(clean []byte, i int) (int, error) {
	for j := i + 1; j < len(clean); j++ {
		switch clean[j] {
		case '\\':
			j++
		case '"':
			return j + 1, nil
		}
	}
	return 0, errors.New("unterminated string")
}

// valueEnd returns the index after the value that starts at i.
func valueEnd(clean []byte, i int) (int, error) {
	if i >= len(clean) {
		return 0, errors.New("missing value")
	}
	switch clean[i] {
	case '"':
		return stringEnd(clean, i)
	case '{', '[':
		depth := 0
		for j := i; j < len(clean); j++ {
			switch clean[j] {
			case '"':
				end, err := stringEnd(clean, j)
				if err != nil {
					return 0, err
				}
				j = end - 1
			case '{', '[':
				depth++
			case '}', ']':
				depth--
				if depth == 0 {
					return j + 1, nil
				}
			}
		}
		return 0, errors.New("unterminated value")
	}
	j := i
	for j < len(clean) && !strings.ContainsRune(",}] \t\r\n", rune(clean[j])) {
		j++
	}
	return j, nil
}

// scanObject lists the members of the object whose opening brace is at open, and returns the index of its closing brace.
func scanObject(clean []byte, open int) ([]member, int, error) {
	var members []member
	i := open + 1
	for {
		i = skipSpace(clean, i)
		if i >= len(clean) {
			return nil, 0, errors.New("unterminated object")
		}
		if clean[i] == '}' {
			return members, i, nil
		}
		if clean[i] != '"' {
			return nil, 0, errors.New("invalid object")
		}
		keyEnd, err := stringEnd(clean, i)
		if err != nil {
			return nil, 0, err
		}
		var key string
		if err := json.Unmarshal(clean[i:keyEnd], &key); err != nil {
			return nil, 0, err
		}
		colon := skipSpace(clean, keyEnd)
		if colon >= len(clean) || clean[colon] != ':' {
			return nil, 0, errors.New("invalid object")
		}
		start := skipSpace(clean, colon+1)
		end, err := valueEnd(clean, start)
		if err != nil {
			return nil, 0, err
		}
		members = append(members, member{key: key, keyStart: i, valStart: start, valEnd: end})
		i = skipSpace(clean, end)
		if i < len(clean) && clean[i] == ',' {
			i++
		}
	}
}

func lineStart(text []byte, i int) int {
	if at := bytes.LastIndexByte(text[:i], '\n'); at >= 0 {
		return at + 1
	}
	return 0
}

func lineIndent(text []byte, i int) string {
	start := lineStart(text, i)
	end := start
	for end < len(text) && (text[end] == ' ' || text[end] == '\t') {
		end++
	}
	return string(text[start:end])
}

func splice(text []byte, start, end int, replacement string) []byte {
	result := make([]byte, 0, len(text)-(end-start)+len(replacement))
	result = append(append(append(result, text[:start]...), replacement...), text[end:]...)
	return result
}

func indentJSON(raw []byte, indent string) string {
	var buffer bytes.Buffer
	if err := json.Indent(&buffer, raw, indent, "  "); err != nil {
		return string(raw)
	}
	return buffer.String()
}

// nest wraps a value in the objects of the remaining path.
func nest(path []string, raw json.RawMessage) json.RawMessage {
	for i := len(path) - 1; i >= 0; i-- {
		body, _ := json.Marshal(map[string]json.RawMessage{path[i]: raw})
		raw = body
	}
	return raw
}

// setValue sets the value at the path (or removes it when raw is nil), creating the keys that are missing.
func setValue(text []byte, path []string, raw json.RawMessage) ([]byte, error) {
	clean, err := cleanJSONC(text)
	if err != nil {
		return nil, err
	}
	open := skipSpace(clean, 0)
	if open >= len(clean) {
		if raw == nil {
			return text, nil
		}
		return setValue([]byte("{\n}\n"), path, raw)
	}
	if clean[open] != '{' {
		return nil, errors.New("configuration must be an object")
	}
	return setIn(text, clean, open, path, raw)
}

func setIn(text, clean []byte, open int, path []string, raw json.RawMessage) ([]byte, error) {
	members, closeAt, err := scanObject(clean, open)
	if err != nil {
		return nil, err
	}
	found := -1
	for i, m := range members {
		if m.key == path[0] {
			found = i
		}
	}
	if found < 0 {
		if raw == nil {
			return text, nil
		}
		return insertMember(text, open, members, closeAt, path[0], nest(path[1:], raw)), nil
	}
	m := members[found]
	if len(path) == 1 {
		if raw == nil {
			return deleteMember(text, members, found), nil
		}
		return splice(text, m.valStart, m.valEnd, indentJSON(raw, lineIndent(text, m.keyStart))), nil
	}
	if clean[m.valStart] == '{' {
		return setIn(text, clean, m.valStart, path[1:], raw)
	}
	if raw == nil {
		return text, nil
	}
	return splice(text, m.valStart, m.valEnd, indentJSON(nest(path[1:], raw), lineIndent(text, m.keyStart))), nil
}

func insertMember(text []byte, open int, members []member, closeAt int, key string, raw json.RawMessage) []byte {
	multiline := bytes.ContainsRune(text[open:closeAt], '\n')
	outer := lineIndent(text, open)
	indent := outer + "  "
	if len(members) > 0 {
		indent = lineIndent(text, members[0].keyStart)
	}
	name, _ := json.Marshal(key)
	entry := string(name) + ": " + indentJSON(raw, indent)
	if len(members) == 0 {
		if len(bytes.TrimSpace(text[open+1:closeAt])) == 0 {
			if multiline || closeAt == open+1 {
				return splice(text, open+1, closeAt, "\n"+indent+entry+"\n"+outer)
			}
			return splice(text, open+1, closeAt, " "+entry+" ")
		}
		return splice(text, open+1, open+1, "\n"+indent+entry)
	}
	last := members[len(members)-1]
	separator := "\n" + indent
	if !multiline {
		separator = " "
	}
	at := last.valEnd
	for at < closeAt && isSpace(text[at]) {
		at++
	}
	if at < closeAt && text[at] == ',' {
		return splice(text, at+1, at+1, separator+entry+",")
	}
	return splice(text, last.valEnd, last.valEnd, ","+separator+entry)
}

func deleteMember(text []byte, members []member, i int) []byte {
	start, end := members[i].keyStart, members[i].valEnd
	after := end
	for after < len(text) && isSpace(text[after]) {
		after++
	}
	if after < len(text) && text[after] == ',' {
		end = after + 1
	} else if i > 0 {
		before := members[i-1].valEnd
		for before < start && isSpace(text[before]) {
			before++
		}
		if before < start && text[before] == ',' {
			text = splice(text, before, before+1, "")
			start, end = start-1, end-1
		}
	}
	first := lineStart(text, start)
	last := end
	for last < len(text) && (text[last] == ' ' || text[last] == '\t' || text[last] == '\r') {
		last++
	}
	if len(bytes.TrimSpace(text[first:start])) == 0 && (last == len(text) || text[last] == '\n') {
		if last < len(text) {
			last++
		}
		start, end = first, last
	}
	return splice(text, start, end, "")
}
