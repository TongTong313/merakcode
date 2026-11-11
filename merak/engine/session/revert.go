package session

import (
	"errors"

	"github.com/TongTong313/merakcode/merak/engine/event"
	"github.com/TongTong313/merakcode/merak/engine/model"
)

const (
	// Tracked records the workspace just before a step that can change files.
	Tracked event.Type = "snapshot.tracked"
	// Reverted hides a user message and everything after it; Unreverted brings them back.
	Reverted   event.Type = "session.reverted"
	Unreverted event.Type = "session.unreverted"
)

func init() {
	event.Register[Track](Tracked)
	event.Register[Revert](Reverted)
	event.Register[struct{}](Unreverted)
}

// Mark remembers where a message of the user starts in State.Messages.
type Mark struct {
	ID    event.ID `json:"id"`
	Index int      `json:"index"`
}

// Track is a workspace snapshot taken when the session had Index messages.
type Track struct {
	Index int    `json:"index"`
	Tree  string `json:"tree"`
}

// Revert is the payload of Reverted: the message that was reverted to, the workspace before the files were put
// back (so unrevert can undo it) and the workspace they were put back to ("" when no file could have changed).
type Revert struct {
	Message  event.ID `json:"message"`
	Current  string   `json:"current,omitempty"`
	Restored string   `json:"restored,omitempty"`
}

// Hidden keeps what a revert took out of the live state until a new message commits it or unrevert undoes it.
type Hidden struct {
	Index    int             `json:"index"`
	Messages []model.Message `json:"messages"`
	Marks    []Mark          `json:"marks,omitempty"`
	Tracks   []Track         `json:"tracks,omitempty"`
	Current  string          `json:"current,omitempty"`
}

// MarkOf finds a user message by the id of its event.
func (s *State) MarkOf(id event.ID) (Mark, bool) {
	for _, mark := range s.Marks {
		if mark.ID == id {
			return mark, true
		}
	}
	return Mark{}, false
}

// RestoreTree returns the workspace snapshot to put back when reverting to the message at index: the one taken
// before the first step that followed it.
func (s *State) RestoreTree(index int) string {
	for _, track := range s.Tracks {
		if track.Index > index {
			return track.Tree
		}
	}
	return ""
}

func (s *State) foldRevert(e event.Event) error {
	switch e.Type {
	case Tracked:
		track, err := event.Decode[Track](e)
		if err != nil {
			return err
		}
		track.Index = len(s.Messages)
		s.Tracks = append(s.Tracks, track)
	case Reverted:
		revert, err := event.Decode[Revert](e)
		if err != nil {
			return err
		}
		mark, ok := s.MarkOf(revert.Message)
		if !ok || mark.Index > len(s.Messages) {
			return errors.New("revert target is not a message of the session")
		}
		hidden := &Hidden{Index: mark.Index, Messages: s.Messages[mark.Index:], Current: revert.Current}
		for _, m := range s.Marks {
			if m.Index >= mark.Index {
				hidden.Marks = append(hidden.Marks, m)
			}
		}
		for _, t := range s.Tracks {
			if t.Index > mark.Index {
				hidden.Tracks = append(hidden.Tracks, t)
			}
		}
		s.Messages = s.Messages[:mark.Index:mark.Index]
		s.Marks = s.Marks[: len(s.Marks)-len(hidden.Marks) : len(s.Marks)-len(hidden.Marks)]
		s.Tracks = s.Tracks[: len(s.Tracks)-len(hidden.Tracks) : len(s.Tracks)-len(hidden.Tracks)]
		s.Hidden = hidden
	case Unreverted:
		if s.Hidden == nil {
			return errors.New("nothing was reverted")
		}
		s.Messages = append(s.Messages, s.Hidden.Messages...)
		s.Marks = append(s.Marks, s.Hidden.Marks...)
		s.Tracks = append(s.Tracks, s.Hidden.Tracks...)
		s.Hidden = nil
	}
	return nil
}

// noteUserMessage keeps the position of a message of the user so it can be reverted to; a message sent after a
// revert commits the revert.
func (s *State) noteUserMessage(e event.Event, role model.Role) {
	if role != model.User {
		return
	}
	s.Hidden = nil
	s.Marks = append(s.Marks, Mark{ID: e.ID, Index: len(s.Messages)})
}

// shiftAfterRebuild keeps marks and tracks pointing at the right messages after the first `to` messages were
// replaced by one summary.
func (s *State) shiftAfterRebuild(to int) {
	var marks []Mark
	for _, m := range s.Marks {
		if m.Index >= to {
			marks = append(marks, Mark{ID: m.ID, Index: m.Index - to + 1})
		}
	}
	var tracks []Track
	for _, t := range s.Tracks {
		if t.Index > to {
			tracks = append(tracks, Track{Index: t.Index - to + 1, Tree: t.Tree})
		}
	}
	s.Marks, s.Tracks = marks, tracks
}
