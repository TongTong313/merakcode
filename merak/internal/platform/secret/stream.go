package secret

import (
	"regexp"
	"strings"
	"unicode"
	"unicode/utf8"
)

var pendingCredential = regexp.MustCompile(`(?i)(?:\b(?:sk-|gh[pousr]_|github_pat_|AKIA|eyJ)[A-Za-z0-9._~+/=-]*|\b(?:password|passwd|api[_-]?key|access[_-]?token|secret[_-]?key|client[_-]?secret)["']?\s*(?:[:=]\s*["']?[^\s"',;}{]*)?|\bbearer(?:\s+[A-Za-z0-9._~+/-]*)?|-----BEGIN(?: [A-Z]*)*)$`)

var credentialPrefixes = []string{"sk-", "ghp_", "gho_", "ghu_", "ghs_", "ghr_", "github_pat_", "akia", "eyj", "password", "passwd", "apikey", "api_key", "api-key", "accesstoken", "access_token", "access-token", "secretkey", "secret_key", "secret-key", "clientsecret", "client_secret", "client-secret", "bearer", "-----begin"}

// Stream retains only possible credential prefixes, allowing ordinary text through immediately.
type Stream struct {
	pending  string
	skipping bool
	prior    rune
}

func (s *Stream) Append(text string) string {
	if s.skipping {
		at := strings.IndexFunc(text, unicode.IsSpace)
		if at < 0 {
			return ""
		}
		text, s.skipping = text[at:], false
	}
	s.pending += text
	end := len(s.pending)
	if candidate := pendingCredential.FindStringIndex(s.pending); candidate != nil && (candidate[0] > 0 || !wordRune(s.prior)) {
		end = candidate[0]
	}
	for _, prefix := range credentialPrefixes {
		for length := 1; length < len(prefix) && length <= len(s.pending); length++ {
			at := len(s.pending) - length
			if at >= end || !strings.EqualFold(s.pending[at:], prefix[:length]) {
				continue
			}
			prior := s.prior
			if at > 0 {
				prior, _ = utf8.DecodeLastRuneInString(s.pending[:at])
			}
			if wordRune(prior) {
				continue
			}
			end = at
		}
	}
	clean := Redact(s.pending[:end])
	if end > 0 {
		s.prior, _ = utf8.DecodeLastRuneInString(s.pending[:end])
	}
	s.pending = s.pending[end:]
	if len(s.pending) > 1<<20 {
		clean += "[redacted]"
		s.pending, s.skipping = "", true
	}
	return clean
}

func (s *Stream) Finish() string {
	text := Redact(s.pending)
	s.pending, s.skipping = "", false
	return text
}

func wordRune(r rune) bool { return unicode.IsLetter(r) || unicode.IsDigit(r) || r == '_' }
