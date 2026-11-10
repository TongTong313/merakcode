package session

import "github.com/TongTong313/merakcode/merak/engine/event"

const MCPConfigured event.Type = "session.mcp_configured"
const Warning event.Type = "session.warning"

type MCPChoice struct {
	Name string `json:"name"`
	Hash string `json:"hash"`
	User bool   `json:"user,omitempty"`
}
type MCPSelection struct {
	Servers []MCPChoice `json:"servers"`
}
type Diagnostic struct {
	Code   string `json:"code"`
	Server string `json:"server,omitempty"`
}

func init() {
	event.Register[MCPSelection](MCPConfigured)
	event.Register[Diagnostic](Warning)
}

func (s *State) AddWarning(value Diagnostic) {
	for _, existing := range s.Warnings {
		if existing == value {
			return
		}
	}
	if len(s.Warnings) >= 64 {
		s.Warnings = s.Warnings[1:]
	}
	s.Warnings = append(s.Warnings, value)
}
