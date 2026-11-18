// Package secret detects recognizable credentials before text leaves a trusted boundary.
package secret

import (
	"regexp"
	"strings"
)

type credentialPattern struct {
	expression *regexp.Regexp
	markers    []string
}

var patterns = []credentialPattern{
	{regexp.MustCompile(`\bsk-(?:ant-[A-Za-z0-9_-]+|[A-Za-z0-9_-]{20,})`), []string{"sk-"}},
	{regexp.MustCompile(`\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|AKIA[A-Z0-9]{16})\b`), []string{"gh", "github_pat_", "AKIA"}},
	{regexp.MustCompile(`-----BEGIN (?:[A-Z]+ )?PRIVATE KEY-----`), []string{"-----BEGIN "}},
	{regexp.MustCompile(`\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b`), []string{"eyJ"}},
	{regexp.MustCompile(`(?i)\b(?:password|passwd|api[_-]?key|access[_-]?token|secret[_-]?key|client[_-]?secret)\b["']?\s*[:=]\s*["']?[^\s"',;}{]{4,}`), []string{":", "="}},
	{regexp.MustCompile(`(?i)\bbearer\s+[A-Za-z0-9._~+/-]{16,}`), []string{" ", "\t", "\n", "\f", "\r"}},
}

// Each match must contain one marker. Case-insensitive expressions use only
// punctuation or whitespace markers, preserving Unicode case folding.
func (p credentialPattern) possible(text string) bool {
	for _, marker := range p.markers {
		if strings.Contains(text, marker) {
			return true
		}
	}
	return false
}

func Contains(text string) bool {
	for _, pattern := range patterns {
		if pattern.possible(text) && pattern.expression.MatchString(text) {
			return true
		}
	}
	return false
}

func Redact(text string) string {
	for _, pattern := range patterns {
		if pattern.possible(text) {
			text = pattern.expression.ReplaceAllString(text, "[redacted]")
		}
	}
	return text
}

func SensitiveKey(key string) bool {
	key = strings.Map(func(r rune) rune {
		if r >= 'A' && r <= 'Z' {
			return r + 'a' - 'A'
		}
		if r >= 'a' && r <= 'z' {
			return r
		}
		return -1
	}, key)
	switch key {
	case "key", "apikey", "token", "accesstoken", "refreshtoken", "password", "passwd", "secret", "secretkey", "clientsecret", "authorization", "cookie", "setcookie", "headers", "environment", "env":
		return true
	}
	return false
}

func RedactValue(value any) any {
	switch value := value.(type) {
	case string:
		return Redact(value)
	case map[string]any:
		clean := make(map[string]any, len(value))
		for key, item := range value {
			if SensitiveKey(key) {
				clean[key] = "[redacted]"
			} else {
				clean[key] = RedactValue(item)
			}
		}
		return clean
	case []any:
		clean := make([]any, len(value))
		for i, item := range value {
			clean[i] = RedactValue(item)
		}
		return clean
	default:
		return value
	}
}
