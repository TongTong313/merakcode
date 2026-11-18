package task

import "strings"

const titleLimit = 80

// TitleFrom derives a card title from free text: its first non-blank line, at most 80 characters.
func TitleFrom(text string) string {
	for line := range strings.SplitSeq(text, "\n") {
		line = strings.TrimSpace(line)
		if line == "" {
			continue
		}
		if runes := []rune(line); len(runes) > titleLimit {
			return string(runes[:titleLimit])
		}
		return line
	}
	return ""
}
