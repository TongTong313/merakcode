// Package command collects the slash commands of a workspace: the built-in ones, those of the configuration and of
// command files, one for every skill and one for every prompt of an MCP server.
package command

import (
	"io/fs"
	"os"
	"path/filepath"
	"slices"
	"strings"

	"github.com/TongTong313/merakcode/merak/engine/skill"
)

// Source says where a command is defined.
type Source string

const (
	Builtin     Source = "builtin"
	Config      Source = "config"
	File        Source = "file"
	SkillSource Source = "skill"
	MCP         Source = "mcp"
)

// Command is one slash command.
type Command struct {
	Name        string `json:"name"`
	Description string `json:"description"`
	Source      Source `json:"source"`
	// Template is the text sent to the model, with $ARGUMENTS where the user's words go. An MCP command has none:
	// the server expands it.
	Template string `json:"template,omitempty"`
	// Agent and Model say who runs the command, when it names them.
	Agent string `json:"agent,omitempty"`
	Model string `json:"model,omitempty"`
	// Local commands are answered by the engine and never reach the model.
	Local bool `json:"local,omitempty"`
	// Server, Prompt and Arguments name the MCP prompt of an MCP command and the names of its arguments.
	Server    string   `json:"server,omitempty"`
	Prompt    string   `json:"prompt,omitempty"`
	Arguments []string `json:"arguments,omitempty"`
}

// Entry is a command defined in the configuration (the v0.3 `command` section).
type Entry struct {
	Template    string `json:"template"`
	Description string `json:"description,omitempty"`
	Agent       string `json:"agent,omitempty"`
	Model       string `json:"model,omitempty"`
}

// MCPPrompt is a prompt of a connected MCP server.
type MCPPrompt struct {
	Server      string
	Name        string
	Description string
	Arguments   []string
}

// Expand puts the user's words into the template. A template without a place for them keeps them after it.
func (c Command) Expand(arguments string) string {
	arguments = strings.TrimSpace(arguments)
	if strings.Contains(c.Template, "$ARGUMENTS") {
		return strings.TrimSpace(strings.ReplaceAll(c.Template, "$ARGUMENTS", arguments))
	}
	if arguments == "" {
		return strings.TrimSpace(c.Template)
	}
	return strings.TrimSpace(c.Template) + "\n\n" + arguments
}

const initTemplate = `Create or update the AGENTS.md file at the root of this project. AGENTS.md tells a coding agent how to work here.

First look at the project: its README, package or build files, the folder layout, the scripts for building, testing and linting, and any existing AGENTS.md or contributor guide. Learn the real commands rather than guessing them.

Then write AGENTS.md in Markdown, short and specific: what the project is, the layout in a few lines, the exact commands to build, test and lint, the code style and conventions you saw, and the things that are easy to get wrong. Do not repeat what the README says at length, and do not invent rules. If an AGENTS.md already exists, keep what is still true and fix what is out of date.

$ARGUMENTS`

const reviewTemplate = `Review the current changes in this repository. Run git status and git diff (and git diff --staged) to see what changed.

Read the changed files around the diffs when you need context. Look for bugs, missed edge cases, broken callers, missing tests, security problems and anything that does not fit the style of the code around it. Say what you checked.

Report the problems first, most serious first, each with the file and line and why it is a problem and how to fix it. Then list what looks fine in a sentence or two. Do not change any file.

$ARGUMENTS`

func builtins() []Command {
	return []Command{
		{Name: "init", Description: "Create or update AGENTS.md for this project", Source: Builtin, Template: initTemplate},
		{Name: "review", Description: "Review the current changes", Source: Builtin, Template: reviewTemplate},
		{Name: "context", Description: "Show where the context of this conversation goes", Source: Builtin, Local: true},
	}
}

// List returns every command that applies to a workspace, sorted by name. A command of the project wins over a
// global one, and both win over the configuration's, the skills' and the built-in ones with the same name.
func List(project, global string, configured map[string]Entry, skills skill.Set, prompts []MCPPrompt) ([]Command, error) {
	byName := map[string]Command{}
	for _, c := range builtins() {
		byName[c.Name] = c
	}
	for _, found := range skills.Skills {
		byName[found.Name] = Command{Name: found.Name, Description: found.Description, Source: SkillSource,
			Template: "Load the skill " + found.Name + " with the skill tool and follow it for this request: $ARGUMENTS"}
	}
	for _, prompt := range prompts {
		name := prompt.Server + ":" + prompt.Name
		byName[name] = Command{Name: name, Description: prompt.Description, Source: MCP, Server: prompt.Server, Prompt: prompt.Name, Arguments: prompt.Arguments}
	}
	for name, entry := range configured {
		byName[name] = Command{Name: name, Description: entry.Description, Source: Config, Template: entry.Template, Agent: entry.Agent, Model: entry.Model}
	}
	for _, root := range []string{global, filepath.Join(project, ".merakcode")} {
		if root == "" {
			continue
		}
		for _, folder := range []string{"command", "commands"} {
			base := filepath.Join(root, folder)
			_ = filepath.WalkDir(base, func(file string, entry fs.DirEntry, err error) error {
				if err != nil || entry.IsDir() || !strings.EqualFold(filepath.Ext(file), ".md") {
					return nil
				}
				relative, err := filepath.Rel(base, file)
				if err != nil {
					return nil
				}
				body, err := os.ReadFile(file)
				if err != nil {
					return nil
				}
				name := strings.TrimSuffix(filepath.ToSlash(relative), filepath.Ext(relative))
				found := fromFile(name, string(body))
				byName[name] = found
				return nil
			})
		}
	}
	list := make([]Command, 0, len(byName))
	for _, c := range byName {
		list = append(list, c)
	}
	slices.SortFunc(list, func(a, b Command) int { return strings.Compare(a.Name, b.Name) })
	return list, nil
}

// fromFile reads a command file: an optional front matter (description, agent, model) and the template.
func fromFile(name, text string) Command {
	text = strings.ReplaceAll(strings.TrimPrefix(text, "\ufeff"), "\r\n", "\n")
	command := Command{Name: name, Source: File, Template: strings.TrimSpace(text)}
	rest, ok := strings.CutPrefix(text, "---\n")
	if !ok {
		return command
	}
	head, body, found := strings.Cut(rest, "\n---")
	if !found {
		return command
	}
	command.Template = strings.TrimSpace(strings.TrimPrefix(body, "\n"))
	for _, line := range strings.Split(head, "\n") {
		key, value, found := strings.Cut(line, ":")
		if !found {
			continue
		}
		value = strings.Trim(strings.TrimSpace(value), `"'`)
		switch strings.TrimSpace(key) {
		case "description":
			command.Description = value
		case "agent":
			command.Agent = value
		case "model":
			command.Model = value
		}
	}
	return command
}

// Result is what running a command did: it either sent a message to the model (Sent) or, for a command the engine
// answers itself, produced Text.
type Result struct {
	Sent bool   `json:"sent"`
	Text string `json:"text,omitempty"`
}
