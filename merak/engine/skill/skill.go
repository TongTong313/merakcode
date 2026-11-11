// Package skill finds the skills an agent can load. A skill is a folder with a SKILL.md (a name and a description in
// its front matter, instructions in its body) and any files that go with it.
package skill

import (
	"embed"
	"errors"
	"io/fs"
	"os"
	"path"
	"path/filepath"
	"slices"
	"strings"
)

//go:embed builtin
var builtin embed.FS

// Source says where a skill came from; a skill of the project wins over a global one, and both win over a built-in one.
type Source string

const (
	Project Source = "project"
	Global  Source = "global"
	Builtin Source = "builtin"
)

// Skill is one skill.
type Skill struct {
	Name        string `json:"name"`
	Description string `json:"description"`
	Source      Source `json:"source"`
	// Dir is the folder of the skill; empty for a built-in one.
	Dir  string `json:"dir,omitempty"`
	body string
}

// Set is every skill that applies to a workspace.
type Set struct {
	Skills []Skill `json:"skills"`
	// Problems name the skill folders that could not be used, with the reason.
	Problems []string `json:"problems,omitempty"`
}

// Names returns the names of the skills, sorted.
func (s Set) Names() []string {
	names := make([]string, len(s.Skills))
	for i, skill := range s.Skills {
		names[i] = skill.Name
	}
	return names
}

// Discover finds the skills of a project folder, of the global folder (the root that holds a skills/ folder) and
// of extra folders (each holding skill folders directly). Project skills win over the others; built-in skills come
// last. A folder that is not a usable skill is reported in Problems and skipped.
func Discover(project, global string, extra ...string) (Set, error) {
	var set Set
	seen := make(map[string]bool)
	add := func(source Source, root string) {
		entries, err := os.ReadDir(root)
		if err != nil {
			return
		}
		for _, entry := range entries {
			dir := filepath.Join(root, entry.Name())
			if !entry.IsDir() {
				if info, err := os.Stat(dir); err != nil || !info.IsDir() {
					continue
				}
			}
			text, err := os.ReadFile(filepath.Join(dir, "SKILL.md"))
			if err != nil {
				continue
			}
			found, ok := parse(string(text))
			if !ok || found.Name == "" || found.Description == "" {
				set.Problems = append(set.Problems, dir+": SKILL.md needs a front matter with a name and a description")
				continue
			}
			if seen[found.Name] {
				continue
			}
			seen[found.Name] = true
			found.Source, found.Dir = source, dir
			set.Skills = append(set.Skills, found)
		}
	}
	if project != "" {
		add(Project, filepath.Join(project, ".merakcode", "skills"))
	}
	if global != "" {
		add(Global, filepath.Join(global, "skills"))
	}
	for _, folder := range extra {
		add(Global, folder)
	}
	entries, err := fs.ReadDir(builtin, "builtin")
	if err != nil {
		return Set{}, err
	}
	for _, entry := range entries {
		text, err := fs.ReadFile(builtin, path.Join("builtin", entry.Name(), "SKILL.md"))
		if err != nil {
			continue
		}
		found, ok := parse(string(text))
		if !ok || seen[found.Name] {
			continue
		}
		seen[found.Name] = true
		found.Source = Builtin
		set.Skills = append(set.Skills, found)
	}
	slices.SortFunc(set.Skills, func(a, b Skill) int { return strings.Compare(a.Name, b.Name) })
	return set, nil
}

// parse reads the front matter and the body of a SKILL.md.
func parse(text string) (Skill, bool) {
	text = strings.ReplaceAll(strings.TrimPrefix(text, "\ufeff"), "\r\n", "\n")
	rest, ok := strings.CutPrefix(text, "---\n")
	if !ok {
		return Skill{}, false
	}
	head, body, found := strings.Cut(rest, "\n---")
	if !found {
		return Skill{}, false
	}
	var skill Skill
	for _, line := range strings.Split(head, "\n") {
		key, value, found := strings.Cut(line, ":")
		if !found {
			continue
		}
		value = strings.TrimSpace(value)
		if len(value) >= 2 && (value[0] == '"' && value[len(value)-1] == '"' || value[0] == '\'' && value[len(value)-1] == '\'') {
			value = value[1 : len(value)-1]
		}
		switch strings.TrimSpace(key) {
		case "name":
			skill.Name = value
		case "description":
			skill.Description = value
		}
	}
	skill.body = strings.TrimSpace(strings.TrimPrefix(body, "\n"))
	return skill, true
}

// Read returns the instructions of a skill and the absolute paths of the files that come with it.
func (s Set) Read(name string) (body string, files []string, ok bool) {
	for _, found := range s.Skills {
		if found.Name != name {
			continue
		}
		if found.Source == Builtin {
			return found.body, nil, true
		}
		_ = filepath.WalkDir(found.Dir, func(file string, entry fs.DirEntry, err error) error {
			if err == nil && !entry.IsDir() && !(filepath.Dir(file) == found.Dir && entry.Name() == "SKILL.md") {
				files = append(files, file)
			}
			return nil
		})
		slices.Sort(files)
		return found.body, files, true
	}
	return "", nil, false
}

// Section is the part of the system prompt that lists the skills. It is the same for the whole session.
func (s Set) Section() string {
	if len(s.Skills) == 0 {
		return ""
	}
	lines := []string{"Skills you can load with the skill tool when a task fits (the list does not change during the session):"}
	for _, found := range s.Skills {
		lines = append(lines, "- "+found.Name+": "+found.Description)
	}
	return strings.Join(lines, "\n")
}

// Valid says whether a name can be a skill folder name.
func Valid(name string) error {
	if name == "" || strings.ContainsAny(name, `/\:`) || name == "." || name == ".." || strings.HasPrefix(name, ".") {
		return errors.New("invalid skill name")
	}
	return nil
}
