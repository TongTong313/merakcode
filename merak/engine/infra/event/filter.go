package event

import "slices"

type Filter struct {
	Streams []Stream `json:"streams,omitempty"`
	Types   []Type   `json:"types,omitempty"`
	Scope   Scope    `json:"scope,omitempty"`
}

func (f Filter) Matches(e Event) bool {
	return (len(f.Streams) == 0 || slices.Contains(f.Streams, e.Stream)) &&
		(len(f.Types) == 0 || slices.Contains(f.Types, e.Type)) &&
		(f.Scope.Group == "" || f.Scope.Group == e.Scope.Group) &&
		(f.Scope.Task == "" || f.Scope.Task == e.Scope.Task) &&
		(f.Scope.Session == "" || f.Scope.Session == e.Scope.Session) &&
		(f.Scope.Turn == "" || f.Scope.Turn == e.Scope.Turn)
}
