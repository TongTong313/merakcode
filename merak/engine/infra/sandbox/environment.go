package sandbox

import (
	"runtime"
	"strings"
)

// Environment keeps only exact allowed names and the last value for each name.
func (p Profile) Environment(source []string) []string {
	allowed := make(map[string]bool, len(p.EnvAllow))
	for _, name := range p.EnvAllow {
		if name != "" && !strings.ContainsAny(name, "=\x00") {
			allowed[environmentKey(name)] = true
		}
	}
	result := make([]string, 0, len(allowed))
	positions := make(map[string]int, len(allowed))
	for _, entry := range source {
		name, _, ok := strings.Cut(entry, "=")
		key := environmentKey(name)
		if !ok || !allowed[key] || strings.ContainsRune(entry, '\x00') {
			continue
		}
		if index, ok := positions[key]; ok {
			result[index] = entry
			continue
		}
		positions[key] = len(result)
		result = append(result, entry)
	}
	if p.PrivateDirectory != "" {
		for _, entry := range privateEnvironment(p.PrivateDirectory) {
			name, _, _ := strings.Cut(entry, "=")
			key := environmentKey(name)
			if index, ok := positions[key]; ok {
				result[index] = entry
			} else {
				result = append(result, entry)
			}
		}
	}
	return result
}

func environmentKey(name string) string {
	if runtime.GOOS == "windows" {
		return strings.ToUpper(name)
	}
	return name
}
