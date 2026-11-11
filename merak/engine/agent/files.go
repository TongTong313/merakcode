package agent

import (
	"github.com/TongTong313/merakcode/merak/engine/event"
	"io/fs"
	"os"
	"path/filepath"
	"slices"
	"strings"

	"github.com/TongTong313/merakcode/merak/engine/permission"
)

// Source of an agent that was not saved by a user: it is defined in a file or in the configuration and is read-only.
const (
	SourceFile   = "file"
	SourceConfig = "config"
)

// FromFiles reads the agents defined in files: .merakcode/agent(s)/**/*.md and .merakcode/mode(s)/*.md of the
// project, and agent(s)/**/*.md and mode(s)/*.md under the global root. The name of an agent is its front-matter name
// or its file name; a project agent wins over a global one with the same name.
func FromFiles(project, global string) []Agent {
	seen := make(map[string]bool)
	var found []Agent
	read := func(root string) {
		for _, folder := range []string{"agent", "agents", "mode", "modes"} {
			base := filepath.Join(root, folder)
			_ = filepath.WalkDir(base, func(file string, entry fs.DirEntry, err error) error {
				if err != nil || entry.IsDir() || !strings.EqualFold(filepath.Ext(file), ".md") {
					return nil
				}
				if (folder == "mode" || folder == "modes") && filepath.Dir(file) != base {
					return nil
				}
				body, err := os.ReadFile(file)
				if err != nil {
					return nil
				}
				relative, err := filepath.Rel(base, file)
				if err != nil {
					return nil
				}
				fallback := strings.TrimSuffix(filepath.ToSlash(relative), filepath.Ext(relative))
				a := parseFile(fallback, string(body))
				if seen[a.Name] {
					return nil
				}
				seen[a.Name] = true
				found = append(found, a)
				return nil
			})
		}
	}
	if project != "" {
		read(filepath.Join(project, ".merakcode"))
	}
	if global != "" {
		read(global)
	}
	slices.SortFunc(found, func(a, b Agent) int { return strings.Compare(a.Name, b.Name) })
	return found
}

// parseFile reads the front matter (name, description, model, tools, permission) and the body, which is the system prompt.
func parseFile(fallback, text string) Agent {
	text = strings.ReplaceAll(strings.TrimPrefix(text, "\ufeff"), "\r\n", "\n")
	a := Agent{Name: fallback, Role: Worker, ToolPool: "worker.default", Source: SourceFile}
	body := text
	if rest, ok := strings.CutPrefix(text, "---\n"); ok {
		if head, tail, found := strings.Cut(rest, "\n---"); found {
			body = strings.TrimPrefix(tail, "\n")
			for _, line := range strings.Split(head, "\n") {
				key, value, found := strings.Cut(line, ":")
				if !found {
					continue
				}
				value = strings.TrimSpace(value)
				switch strings.TrimSpace(key) {
				case "name":
					if unquoted := unquote(value); unquoted != "" {
						a.Name = unquoted
					}
				case "description":
					a.Summary = unquote(value)
				case "model":
					a.Model.Provider, a.Model.Model, _ = strings.Cut(unquote(value), "/")
				case "tools":
					a.Tools = list(value)
				case "permission", "mode":
					switch mode := permission.Mode(unquote(value)); mode {
					case permission.ModeAsk, permission.ModeAuto, permission.ModeTakeover:
						a.Mode = mode
					}
				}
			}
		}
	}
	a.System = strings.TrimSpace(body)
	a.ID = event.ID("file:" + a.Name)
	return a
}

func unquote(value string) string {
	if len(value) >= 2 && (value[0] == '"' && value[len(value)-1] == '"' || value[0] == '\'' && value[len(value)-1] == '\'') {
		return value[1 : len(value)-1]
	}
	return value
}

func list(value string) []string {
	var items []string
	for _, item := range strings.Split(strings.Trim(value, "[]"), ",") {
		if item = unquote(strings.TrimSpace(item)); item != "" {
			items = append(items, item)
		}
	}
	return items
}
