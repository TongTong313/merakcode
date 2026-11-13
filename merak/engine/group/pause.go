package group

import (
	"slices"

	"github.com/TongTong313/merakcode/merak/engine/event"
)

// Paused halts a group: only a Leader that keeps failing does it (MRK-4004), and what a person writes in the group
// resumes it. There is no control for people.
const Paused event.Type = "group.paused"
const Resumed event.Type = "group.resumed"

type Control struct {
	Thread  event.ID `json:"thread"`
	Session event.ID `json:"session,omitempty"`
	Code    string   `json:"code,omitempty"`
}

func init() { event.Register[Control](Paused); event.Register[Control](Resumed) }

func (s State) IsPaused(thread event.ID) bool {
	return slices.Contains(s.PausedThreads, s.Group.ID) || slices.Contains(s.PausedThreads, thread)
}

func FoldPauses(paused []event.ID, fact event.Event) ([]event.ID, error) {
	control, err := event.Decode[Control](fact)
	if err != nil {
		return nil, err
	}
	thread := control.Thread
	if thread == "" {
		thread = fact.Scope.Group
	}
	if fact.Type == Paused {
		if !slices.Contains(paused, thread) {
			paused = append(paused, thread)
		}
		return paused, nil
	}
	if thread == fact.Scope.Group {
		return nil, nil
	}
	return slices.DeleteFunc(paused, func(id event.ID) bool { return id == thread }), nil
}
