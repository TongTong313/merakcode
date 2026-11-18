package session

import (
	"context"
	"maps"
	"slices"
	"sync"
	"time"

	"github.com/TongTong313/merakcode/merak/engine/agent/model"
	"github.com/TongTong313/merakcode/merak/engine/agent/tool"
	"github.com/TongTong313/merakcode/merak/engine/infra/event"
)

// stateGuard belongs to a managed session, not to its serialized state. Manager
// installs it before publishing the pointer. Standalone states have one owner.
type stateGuard struct {
	data    sync.RWMutex
	publish sync.Mutex
	save    sync.Mutex
}

// Identity reads the session and member IDs without copying conversation history.
func (s *State) Identity() (id, member event.ID) {
	if s.guard != nil {
		s.guard.data.RLock()
		defer s.guard.data.RUnlock()
	}
	return s.ID, s.Config.Member
}

func (s *State) openCall(id string) (model.ToolCall, event.ID, bool) {
	if s.guard != nil {
		s.guard.data.RLock()
		defer s.guard.data.RUnlock()
	}
	call, open := s.Open[id]
	call.Input = slices.Clone(call.Input)
	return call, s.Causes[id], open
}

// Read returns a detached, consistent state. Callers must use it when reading a
// managed session while another goroutine can publish events or save a snapshot.
func (s *State) Read() *State {
	if s.guard != nil {
		s.guard.data.RLock()
		defer s.guard.data.RUnlock()
	}
	copy := *s
	copy.guard = nil
	copy.Config.Switches = maps.Clone(s.Config.Switches)
	copy.Marks = slices.Clone(s.Marks)
	copy.Tracks = slices.Clone(s.Tracks)
	copy.Todos = slices.Clone(s.Todos)
	copy.Warnings = slices.Clone(s.Warnings)
	copy.Loaded = slices.Clone(s.Loaded)
	copy.Children = maps.Clone(s.Children)
	copy.Causes = maps.Clone(s.Causes)
	copy.Messages = cloneMessages(s.Messages)
	copy.Tools = cloneSpecs(s.Tools)
	copy.Open = maps.Clone(s.Open)
	for id, call := range copy.Open {
		call.Input = slices.Clone(call.Input)
		copy.Open[id] = call
	}
	copy.Permissions = maps.Clone(s.Permissions)
	for id, pending := range copy.Permissions {
		pending.Request.Call.Input = slices.Clone(pending.Request.Call.Input)
		pending.Request.Spec.Input = slices.Clone(pending.Request.Spec.Input)
		copy.Permissions[id] = pending
	}
	if s.MCP != nil {
		copy.MCP = &MCPSelection{Servers: slices.Clone(s.MCP.Servers)}
	}
	if s.Hidden != nil {
		hidden := *s.Hidden
		hidden.Messages = cloneMessages(hidden.Messages)
		hidden.Marks = slices.Clone(hidden.Marks)
		hidden.Tracks = slices.Clone(hidden.Tracks)
		copy.Hidden = &hidden
	}
	return &copy
}

// Publish keeps publication and folding in the same order. The data lock never
// covers event storage or delivery, so readers do not wait for those operations.
func (s *State) Publish(ctx context.Context, bus *event.Bus, input event.Event) (event.Event, error) {
	if s.guard != nil {
		s.guard.publish.Lock()
		defer s.guard.publish.Unlock()
	}
	fact, err := bus.Publish(ctx, input)
	if err != nil {
		return event.Event{}, err
	}
	return fact, Fold(s, fact)
}

// SetTools refreshes runtime tool descriptions without changing the event log.
func (s *State) SetTools(specs []tool.Spec, systemSuffix string) {
	if s.guard != nil {
		s.guard.data.Lock()
		defer s.guard.data.Unlock()
	}
	s.Tools = cloneSpecs(specs)
	s.System += systemSuffix
}

// SetBudgetDeadline records the deadline selected before the next turn starts.
func (s *State) SetBudgetDeadline(deadline time.Time) {
	if s.guard != nil {
		s.guard.data.Lock()
		defer s.guard.data.Unlock()
	}
	s.Config.BudgetDeadline = deadline
}

func cloneSpecs(specs []tool.Spec) []tool.Spec {
	copy := slices.Clone(specs)
	for i := range copy {
		copy[i].Input = slices.Clone(copy[i].Input)
	}
	return copy
}

func cloneMessages(messages []model.Message) []model.Message {
	copy := slices.Clone(messages)
	for i := range copy {
		copy[i].Parts = cloneParts(copy[i].Parts)
	}
	return copy
}

func cloneParts(parts []model.Part) []model.Part {
	copy := slices.Clone(parts)
	for i := range copy {
		part := &copy[i]
		if part.Reasoning != nil {
			value := *part.Reasoning
			value.Opaque = slices.Clone(value.Opaque)
			part.Reasoning = &value
		}
		if part.ToolCall != nil {
			value := *part.ToolCall
			value.Input = slices.Clone(value.Input)
			part.ToolCall = &value
		}
		if part.ToolResult != nil {
			value := *part.ToolResult
			value.Parts = cloneParts(value.Parts)
			part.ToolResult = &value
		}
		if part.Image != nil {
			value := *part.Image
			value.Data = slices.Clone(value.Data)
			part.Image = &value
		}
		if part.Document != nil {
			value := *part.Document
			value.Data = slices.Clone(value.Data)
			part.Document = &value
		}
	}
	return copy
}

// replace changes serialized fields without replacing the live synchronization owner.
func (s *State) replace(value State) {
	s.Marks = value.Marks
	s.Tracks = value.Tracks
	s.Hidden = value.Hidden
	s.Title = value.Title
	s.Archived = value.Archived
	s.Todos = value.Todos
	s.BudgetExtensions = value.BudgetExtensions
	s.Warnings = value.Warnings
	s.MCP = value.MCP
	s.Permissions = value.Permissions
	s.BaseCommit = value.BaseCommit
	s.Children = value.Children
	s.ID = value.ID
	s.Scope = value.Scope
	s.Config = value.Config
	s.System = value.System
	s.Messages = value.Messages
	s.LastSeq = value.LastSeq
	s.Usage = value.Usage
	s.Tools = value.Tools
	s.Loaded = value.Loaded
	s.SummaryID = value.SummaryID
	s.Status = value.Status
	s.Open = value.Open
	s.Causes = value.Causes
}
