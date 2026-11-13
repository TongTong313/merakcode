package session

import (
	"github.com/TongTong313/merakcode/merak/engine/event"
	"github.com/TongTong313/merakcode/merak/engine/model"
	"github.com/TongTong313/merakcode/merak/engine/permission"
)

// Updated records a change to the title, archive state or permission mode of a session.
const Updated event.Type = "session.updated"

func init() { event.Register[Change](Updated) }

// Update is a request to change a session; empty fields stay as they are. Confirm must be true to move a
// session into the takeover mode.
type Update struct {
	Title    *string         `json:"title,omitempty"`
	Archived *bool           `json:"archived,omitempty"`
	Mode     permission.Mode `json:"mode,omitempty"`
	Confirm  bool            `json:"confirm,omitempty"`
}

// Change is the payload of Updated: what the update changed.
type Change struct {
	Title    *string         `json:"title,omitempty"`
	Archived *bool           `json:"archived,omitempty"`
	Mode     permission.Mode `json:"mode,omitempty"`
	// Provider, Model and Thinking move the conversation to another model; a takeover sets them.
	Provider string         `json:"provider,omitempty"`
	Model    string         `json:"model,omitempty"`
	Thinking model.Thinking `json:"thinking,omitempty"`
}

func (s *State) applyChange(change Change) {
	if change.Title != nil {
		s.Title = *change.Title
	}
	if change.Archived != nil {
		s.Archived = *change.Archived
	}
	if change.Mode != "" {
		s.Config.Mode = change.Mode
	}
	if change.Provider != "" {
		s.Config.Provider, s.Config.Model, s.Config.Thinking = change.Provider, change.Model, change.Thinking
	}
}
