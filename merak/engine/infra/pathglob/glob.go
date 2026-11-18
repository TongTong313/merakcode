// Package pathglob matches slash-separated paths, including recursive ** segments.
package pathglob

import (
	"path"
	"strings"
)

type Pattern struct{ segments []string }

func Compile(pattern string) (Pattern, error) {
	segments := strings.Split(pattern, "/")
	for _, segment := range segments {
		if _, err := path.Match(segment, ""); err != nil {
			return Pattern{}, err
		}
	}
	return Pattern{segments: segments}, nil
}

func (p Pattern) Match(name string) bool {
	parts := strings.Split(name, "/")
	previous := make([]bool, len(parts)+1)
	previous[0] = true
	for _, segment := range p.segments {
		next := make([]bool, len(previous))
		if segment == "**" {
			next[0] = previous[0]
		}
		for index, part := range parts {
			if segment == "**" {
				next[index+1] = previous[index+1] || next[index]
				continue
			}
			matched, _ := path.Match(segment, part)
			next[index+1] = previous[index] && matched
		}
		previous = next
	}
	return previous[len(parts)]
}
