// Package memory manages stored notes for engine users.
package memory

import (
	"context"
	"errors"
	"strings"

	agentmemory "github.com/TongTong313/merakcode/merak/engine/agent/memory"
	"github.com/TongTong313/merakcode/merak/engine/agent/registry"
	"github.com/TongTong313/merakcode/merak/engine/infra/event"
)

// Deps supplies the shared objects used to manage stored notes.
type Deps struct {
	Registry *registry.Registry
	Notes    *agentmemory.Repository
}

// Manager manages stored notes using the existing registry and repository.
type Manager struct {
	registry *registry.Registry
	notes    *agentmemory.Repository
}

// New creates the note manager with the engine's shared dependencies.
func New(d Deps) *Manager {
	return &Manager{registry: d.Registry, notes: d.Notes}
}

// MemoryList returns the notes of a project, or of one scope of it, newest first. The scope is "project" (the
// default), "group" or "member".
func (e *Manager) MemoryList(ctx context.Context, directory, scope string) ([]agentmemory.Note, error) {
	if scope == "" || scope == string(agentmemory.ScopeProject) {
		notes, err := e.notes.List(ctx, []agentmemory.Owner{agentmemory.ProjectOwner(e.registry.Directory(directory))})
		return notes, err
	}
	if scope != string(agentmemory.ScopeGroup) && scope != string(agentmemory.ScopeMember) {
		return nil, errors.New("unknown memory scope")
	}
	all, err := e.notes.List(ctx, nil)
	if err != nil {
		return nil, err
	}
	notes := []agentmemory.Note{}
	for _, note := range all {
		if string(note.Scope) == scope {
			notes = append(notes, note)
		}
	}
	return notes, nil
}

// MemoryRead returns one note.
func (e *Manager) MemoryRead(ctx context.Context, id event.ID) (agentmemory.Note, error) {
	if strings.TrimSpace(string(id)) == "" {
		return agentmemory.Note{}, errors.New("a note id is required")
	}
	return e.notes.Read(ctx, id)
}

// MemoryDelete removes one note.
func (e *Manager) MemoryDelete(ctx context.Context, id event.ID) error {
	return e.notes.Delete(ctx, id)
}
