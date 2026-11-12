package migrate

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io/fs"
	"maps"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"time"

	"github.com/TongTong313/merakcode/merak/engine/event"
	"github.com/TongTong313/merakcode/merak/engine/memory"
	"github.com/TongTong313/merakcode/merak/engine/plan"
)

// importPlans gives each conversation that had a plan its plan document, as it ended: Done when v0.3 finished it,
// Stopped in every other case. The plan is read from the record of the conversation, or else from its file in
// data/plans.
func (r *run) importPlans() error {
	rows, err := r.db.records(r.ctx, "session_plan/")
	if err != nil {
		return err
	}
	records := map[string]v03Plan{}
	for _, row := range rows {
		value, err := decode[v03Plan]("plan", row.ID, row.Data)
		if err != nil {
			r.skip("plan", row.ID, codeRecord, err)
			continue
		}
		records[row.ID] = value
	}
	for _, id := range slices.Sorted(maps.Keys(r.record.Sessions)) {
		info, known := r.infos[id]
		if !known || info.ParentID != "" || contains(r.record.Plans, id) {
			continue
		}
		stored, hasRecord := records[id]
		content := stored.Content
		if strings.TrimSpace(content) == "" {
			content = r.planFile(info, stored)
		}
		if strings.TrimSpace(content) == "" {
			continue
		}
		status := plan.Stopped
		if hasRecord && stored.Status == "completed" {
			status = plan.Done
		}
		if _, err := r.m.options.Engine.ImportPlan(r.ctx, event.ID(r.record.Sessions[id]), content, status); err != nil {
			r.skip("plan", id, codeRecord, err)
			continue
		}
		r.record.Plans = append(r.record.Plans, id)
		r.result.Imported.Plans++
		r.saved()
	}
	return nil
}

// planFile reads the file v0.3 kept a plan in, <created>-<slug>.md in data/plans; only that folder is read.
func (r *run) planFile(info v03Session, stored v03Plan) string {
	folder := filepath.Join(r.m.options.Root, "data", "plans")
	names := []string{fmt.Sprintf("%d-%s.md", info.Time.Created, info.Slug)}
	if stored.Path != "" {
		names = append([]string{filepath.Base(filepath.FromSlash(strings.ReplaceAll(stored.Path, `\`, "/")))}, names...)
	}
	for _, name := range names {
		if body, err := os.ReadFile(filepath.Join(folder, name)); err == nil {
			return string(body)
		}
	}
	return ""
}

// memoryTypes are the folders of a project's memory in v0.3 and the kind each becomes.
var memoryTypes = map[string]string{"user": "preference", "feedback": "preference", "project": "fact", "reference": "fact"}

// importMemories turns each memory file of v0.3 into a note of the project whose folder it was kept for. A project
// is found by the name v0.3 gave its memory, from the folders of the conversations that were imported.
func (r *run) importMemories() error {
	projects := filepath.Join(r.m.options.Root, "data", "memory", "projects")
	entries, err := os.ReadDir(projects)
	if errors.Is(err, fs.ErrNotExist) {
		return nil
	}
	if err != nil {
		r.skip("memory", "projects", codeRecord, errors.New("the memory folder cannot be read"))
		return nil
	}
	owners := r.projectFolders()
	for _, entry := range entries {
		if !entry.IsDir() {
			continue
		}
		for kind := range memoryTypes {
			base := filepath.Join(projects, entry.Name(), kind)
			_ = filepath.WalkDir(base, func(path string, item fs.DirEntry, err error) error {
				if err != nil || item.IsDir() || !strings.HasSuffix(strings.ToLower(item.Name()), ".md") {
					return nil
				}
				relative, _ := filepath.Rel(projects, path)
				r.importNote(entry.Name(), kind, filepath.ToSlash(relative), path, owners)
				return nil
			})
		}
	}
	return nil
}

// projectFolders maps the memory name of each folder that an imported conversation worked in, or worked below, to
// that folder.
func (r *run) projectFolders() map[string]string {
	folders := map[string]string{}
	for id := range r.record.Sessions {
		info := r.infos[id]
		for folder := info.Directory; folder != "" && info.Directory != ""; folder = filepath.Dir(folder) {
			if _, taken := folders[projectKey(folder)]; !taken {
				folders[projectKey(folder)] = folder
			}
			if filepath.Dir(folder) == folder {
				break
			}
		}
	}
	return folders
}

func (r *run) importNote(project, kind, relative, path string, folders map[string]string) {
	if contains(r.record.Memories, relative) {
		return
	}
	folder, found := folders[project]
	if !found {
		r.skip("memory", relative, codeMemoryOwner, errors.New("no imported conversation worked in this project"))
		return
	}
	body, err := os.ReadFile(path)
	if err != nil {
		r.skip("memory", relative, codeRecord, errors.New("the file cannot be read"))
		return
	}
	text := noteText(string(body))
	if strings.TrimSpace(text) == "" || len(text) > 8192 {
		r.skip("memory", relative, codeRecord, errors.New("the note is empty or longer than a note may be"))
		return
	}
	created := time.Now().UTC()
	if stat, err := os.Stat(path); err == nil {
		created = stat.ModTime().UTC()
	}
	hash := sha256.Sum256([]byte(relative))
	owner := memory.ProjectOwner(folder)
	note := memory.Note{ID: event.ID("v03-memory-" + hex.EncodeToString(hash[:12])), Scope: owner.Scope, Owner: owner.ID, Kind: memoryTypes[kind], Text: text, Tags: []string{kind}, Created: created}
	if _, err := r.m.options.Engine.ImportNote(r.ctx, note); err != nil {
		if errors.Is(err, memory.ErrSecret) {
			r.skip("memory", relative, codeMemory, errors.New("the note looks like it holds a credential"))
			return
		}
		r.skip("memory", relative, codeRecord, err)
		return
	}
	r.record.Memories = append(r.record.Memories, relative)
	r.result.Imported.Memories++
	r.saved()
}

// noteText joins the name, the description and the body of a memory file, whose head is a block between two lines
// of three dashes.
func noteText(file string) string {
	file = strings.ReplaceAll(file, "\r\n", "\n")
	fields := map[string]string{}
	body := file
	if head, rest, found := strings.Cut(strings.TrimPrefix(file, "---\n"), "\n---"); found && strings.HasPrefix(file, "---\n") {
		for _, line := range strings.Split(head, "\n") {
			if key, value, ok := strings.Cut(line, ":"); ok {
				fields[strings.TrimSpace(key)] = strings.Trim(strings.TrimSpace(value), `"'`)
			}
		}
		body = strings.TrimPrefix(rest, "\n")
	}
	var parts []string
	if name, description := fields["name"], fields["description"]; name != "" || description != "" {
		parts = append(parts, strings.TrimSpace(strings.Join(nonEmpty(name, description), ": ")))
	}
	if body = strings.TrimSpace(body); body != "" {
		parts = append(parts, body)
	}
	return strings.Join(parts, "\n\n")
}

func nonEmpty(values ...string) []string {
	var kept []string
	for _, value := range values {
		if value != "" {
			kept = append(kept, value)
		}
	}
	return kept
}
