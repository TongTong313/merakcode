package config

import (
	"bytes"
	"errors"
	"strings"
)

// cleanJSONC blanks comments and trailing commas with spaces, so every byte offset of the result is also an offset of
// the original text.
func cleanJSONC(data []byte) ([]byte, error) {
	clean := bytes.Clone(data)
	quoted, escaped := false, false
	for i := 0; i < len(clean); i++ {
		char := clean[i]
		if quoted {
			if escaped {
				escaped = false
				continue
			}
			if char == '\\' {
				escaped = true
			} else if char == '"' {
				quoted = false
			}
			continue
		}
		if char == '"' {
			quoted = true
			continue
		}
		if char != '/' || i+1 == len(clean) {
			continue
		}
		if clean[i+1] == '/' {
			for i < len(clean) && clean[i] != '\n' && clean[i] != '\r' {
				clean[i] = ' '
				i++
			}
			i--
		} else if clean[i+1] == '*' {
			clean[i], clean[i+1] = ' ', ' '
			i += 2
			for i+1 < len(clean) && !(clean[i] == '*' && clean[i+1] == '/') {
				if clean[i] != '\n' && clean[i] != '\r' {
					clean[i] = ' '
				}
				i++
			}
			if i+1 >= len(clean) {
				return nil, errors.New("unterminated configuration comment")
			}
			clean[i], clean[i+1] = ' ', ' '
			i++
		}
	}
	quoted, escaped = false, false
	for i, char := range clean {
		if quoted {
			if escaped {
				escaped = false
			} else if char == '\\' {
				escaped = true
			} else if char == '"' {
				quoted = false
			}
			continue
		}
		if char == '"' {
			quoted = true
			continue
		}
		if char != ',' {
			continue
		}
		j := i + 1
		for j < len(clean) && strings.ContainsRune(" \t\r\n", rune(clean[j])) {
			j++
		}
		if j < len(clean) && (clean[j] == '}' || clean[j] == ']') {
			k := i - 1
			for k >= 0 && strings.ContainsRune(" \t\r\n", rune(clean[k])) {
				k--
			}
			if k < 0 || strings.ContainsRune("{[,", rune(clean[k])) {
				return nil, errors.New("invalid trailing comma")
			}
			clean[i] = ' '
		}
	}
	return clean, nil
}
