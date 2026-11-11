// Package rules reads the rules of a project: its AGENTS.md and the .mdc rule files in .merakcode/rules and
// .cursor/rules, from the workspace folder up to the root of its Git repository.
package rules

import (
	"context"
	"encoding/json"
	"errors"
	"io/fs"
	"os"
	"path"
	"path/filepath"
	"regexp"
	"slices"
	"strings"
	"sync"

	"github.com/TongTong313/merakcode/merak/internal/platform/git"
)

// Kind says how a rule reaches the model.
type Kind string

const (
	// Always rules are part of the system prompt.
	Always Kind = "always"
	// Matching rules are attached to the result of reading a file that fits one of their globs, once per session.
	Matching Kind = "matching"
	// Described rules are listed by name and description; the model reads one with the rule tool.
	Described Kind = "described"
)

// MaxBody is the largest body a rule keeps; the rest is cut.
const MaxBody = 32 * 1024

// Rule is one .mdc file.
type Rule struct {
	Name        string   `json:"name"`
	Path        string   `json:"path"`
	Description string   `json:"description,omitempty"`
	Globs       []string `json:"globs,omitempty"`
	AlwaysApply bool     `json:"alwaysApply,omitempty"`
	Body        string   `json:"body"`
	Truncated   bool     `json:"truncated,omitempty"`
}

// Kind says how the rule is used.
func (r Rule) Kind() Kind {
	switch {
	case r.AlwaysApply:
		return Always
	case len(r.Globs) > 0:
		return Matching
	default:
		return Described
	}
}

// Set is everything the project says about how to work in it.
type Set struct {
	// Instructions is the AGENTS.md of the workspace folder.
	Instructions string `json:"instructions,omitempty"`
	// Rules are the rule files, those nearest to the workspace first.
	Rules []Rule `json:"rules"`
}

var ruleFolders = []string{".merakcode/rules", ".merakcode/rule", ".cursor/rules"}

// Load reads the rules that apply to a workspace folder. A rule file that cannot be read is skipped.
func Load(ctx context.Context, workdir string) (Set, error) {
	var set Set
	if body, err := os.ReadFile(filepath.Join(workdir, "AGENTS.md")); err == nil {
		set.Instructions = strings.TrimSpace(string(body))
	} else if !os.IsNotExist(err) {
		return Set{}, err
	}
	top := workdir
	if root, err := git.Root(ctx, workdir); err == nil && within(root, workdir) {
		top = root
	}
	seen := make(map[string]bool)
	for dir := workdir; ; dir = filepath.Dir(dir) {
		for _, folder := range ruleFolders {
			base := filepath.Join(dir, filepath.FromSlash(folder))
			_ = filepath.WalkDir(base, func(file string, entry fs.DirEntry, err error) error {
				if err != nil || entry.IsDir() || !strings.EqualFold(filepath.Ext(file), ".mdc") {
					return nil
				}
				relative, err := filepath.Rel(base, file)
				if err != nil {
					return nil
				}
				name := strings.TrimSuffix(filepath.ToSlash(relative), filepath.Ext(relative))
				if seen[name] {
					return nil
				}
				body, err := os.ReadFile(file)
				if err != nil {
					return nil
				}
				seen[name] = true
				set.Rules = append(set.Rules, parse(name, file, string(body)))
				return nil
			})
		}
		if dir == top || filepath.Dir(dir) == dir {
			break
		}
	}
	return set, nil
}

func within(root, dir string) bool {
	relative, err := filepath.Rel(root, dir)
	return err == nil && relative != ".." && !strings.HasPrefix(relative, ".."+string(filepath.Separator))
}

// parse reads the front matter of a rule file: description, globs and alwaysApply.
func parse(name, file, text string) Rule {
	rule := Rule{Name: name, Path: file}
	text = strings.ReplaceAll(strings.TrimPrefix(text, "\ufeff"), "\r\n", "\n")
	body := text
	if rest, ok := strings.CutPrefix(text, "---\n"); ok {
		if head, tail, found := strings.Cut(rest, "\n---"); found {
			body = strings.TrimPrefix(tail, "\n")
			lines := strings.Split(head, "\n")
			for i := 0; i < len(lines); i++ {
				key, value, found := strings.Cut(lines[i], ":")
				if !found {
					continue
				}
				value = strings.TrimSpace(value)
				switch strings.TrimSpace(key) {
				case "description":
					rule.Description = unquote(value)
				case "alwaysApply":
					rule.AlwaysApply = strings.EqualFold(value, "true")
				case "globs":
					if value == "" {
						for i+1 < len(lines) && strings.HasPrefix(strings.TrimSpace(lines[i+1]), "- ") {
							i++
							rule.Globs = append(rule.Globs, unquote(strings.TrimSpace(strings.TrimPrefix(strings.TrimSpace(lines[i]), "- "))))
						}
						continue
					}
					rule.Globs = globList(value)
				}
			}
		}
	}
	rule.Body = strings.TrimSpace(body)
	if len(rule.Body) > MaxBody {
		cut := MaxBody
		for cut > 0 && !isBoundary(rule.Body, cut) {
			cut--
		}
		rule.Body, rule.Truncated = rule.Body[:cut]+"\n[truncated: the rule is longer than 32 KB]", true
	}
	return rule
}

func isBoundary(text string, at int) bool { return at >= len(text) || text[at]&0xC0 != 0x80 }

func unquote(value string) string {
	if len(value) >= 2 && (value[0] == '"' && value[len(value)-1] == '"' || value[0] == '\'' && value[len(value)-1] == '\'') {
		return value[1 : len(value)-1]
	}
	return value
}

func globList(value string) []string {
	var globs []string
	if strings.HasPrefix(value, "[") {
		if json.Unmarshal([]byte(strings.ReplaceAll(value, "'", `"`)), &globs) != nil {
			globs = nil
			for _, item := range strings.Split(strings.Trim(value, "[]"), ",") {
				globs = append(globs, unquote(strings.TrimSpace(item)))
			}
		}
	} else {
		for _, item := range strings.Split(value, ",") {
			globs = append(globs, unquote(strings.TrimSpace(item)))
		}
	}
	return slices.DeleteFunc(globs, func(glob string) bool { return glob == "" })
}

var matchers sync.Map

// matches says whether a path relative to the workspace fits a glob: ** crosses folders, * does not, and a glob
// with no slash fits the file name at any depth.
func matches(glob, relative string) bool {
	if !strings.Contains(glob, "/") {
		relative = path.Base(relative)
	}
	expression, ok := matchers.Load(glob)
	if !ok {
		var pattern strings.Builder
		pattern.WriteString("^")
		for i := 0; i < len(glob); i++ {
			switch {
			case strings.HasPrefix(glob[i:], "**/"):
				pattern.WriteString("(?:.*/)?")
				i += 2
			case strings.HasPrefix(glob[i:], "**"):
				pattern.WriteString(".*")
				i++
			case glob[i] == '*':
				pattern.WriteString("[^/]*")
			case glob[i] == '?':
				pattern.WriteString("[^/]")
			default:
				pattern.WriteString(regexp.QuoteMeta(string(glob[i])))
			}
		}
		pattern.WriteString("$")
		compiled, err := regexp.Compile(pattern.String())
		if err != nil {
			return false
		}
		expression, _ = matchers.LoadOrStore(glob, compiled)
	}
	return expression.(*regexp.Regexp).MatchString(relative)
}

// Sections returns the parts of the system prompt the rules make: the user's personal rules first, then the
// project's instructions, the rules that always apply and the list of rules the model can read by name.
func (s Set) Sections(personal []string) []string {
	var sections []string
	if len(personal) > 0 {
		sections = append(sections, "Personal rules:\n- "+strings.Join(personal, "\n- "))
	}
	if s.Instructions != "" {
		sections = append(sections, s.Instructions)
	}
	var described []string
	for _, rule := range s.Rules {
		switch rule.Kind() {
		case Always:
			sections = append(sections, "Rule "+rule.Name+":\n"+rule.Body)
		case Described:
			description := rule.Description
			if description == "" {
				description = "(no description)"
			}
			described = append(described, "- "+rule.Name+": "+description)
		}
	}
	if len(described) > 0 {
		sections = append(sections, "Rules you can read with the rule tool when they apply:\n"+strings.Join(described, "\n"))
	}
	return sections
}

// Lookup returns the body of a rule the model reads by name.
func (s Set) Lookup(name string) (string, bool) {
	for _, rule := range s.Rules {
		if rule.Name == name && rule.Kind() == Described {
			return rule.Body, true
		}
	}
	return "", false
}

// HasDescribed says whether any rule is read by name.
func (s Set) HasDescribed() bool {
	return slices.ContainsFunc(s.Rules, func(rule Rule) bool { return rule.Kind() == Described })
}

// Attacher returns a function that, given a file the model has just read, returns the text of the matching rules
// that were not attached yet in this session; it returns "" when there is nothing to add.
func (s Set) Attacher(workdir string) func(file string) string {
	var mu sync.Mutex
	attached := make(map[string]bool)
	return func(file string) string {
		relative, err := filepath.Rel(workdir, file)
		if err != nil || relative == ".." || strings.HasPrefix(relative, ".."+string(filepath.Separator)) {
			return ""
		}
		relative = filepath.ToSlash(relative)
		mu.Lock()
		defer mu.Unlock()
		var parts []string
		for _, rule := range s.Rules {
			if rule.Kind() != Matching || attached[rule.Name] {
				continue
			}
			if slices.ContainsFunc(rule.Globs, func(glob string) bool { return matches(glob, relative) }) {
				attached[rule.Name] = true
				parts = append(parts, "Rule "+rule.Name+" applies to this file:\n"+rule.Body)
			}
		}
		return strings.Join(parts, "\n\n")
	}
}

var ruleName = regexp.MustCompile(`^[A-Za-z0-9._-]+(/[A-Za-z0-9._-]+)*$`)

func ruleFile(root, name string) (string, error) {
	if !ruleName.MatchString(name) || slices.Contains(strings.Split(name, "/"), "..") || slices.Contains(strings.Split(name, "/"), ".") {
		return "", errors.New("invalid rule name")
	}
	return filepath.Join(root, ".merakcode", "rules", filepath.FromSlash(name)+".mdc"), nil
}

// WriteFile creates or replaces the rule file of a project and returns its path.
func WriteFile(root, name, text string) (string, error) {
	file, err := ruleFile(root, name)
	if err != nil {
		return "", err
	}
	if len(text) > 256*1024 {
		return "", errors.New("the rule is too large")
	}
	if err := os.MkdirAll(filepath.Dir(file), 0o755); err != nil {
		return "", err
	}
	return file, os.WriteFile(file, []byte(text), 0o644)
}

// DeleteFile removes the rule file of a project.
func DeleteFile(root, name string) error {
	file, err := ruleFile(root, name)
	if err != nil {
		return err
	}
	return os.Remove(file)
}
