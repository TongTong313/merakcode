package protocol

import "github.com/TongTong313/merakcode/merak/engine/event"

type DiagnosticsParams struct {
	Days       int      `json:"days,omitempty"`
	Session    event.ID `json:"session,omitempty"`
	Group      event.ID `json:"group,omitempty"`
	WithConfig bool     `json:"withConfig,omitempty"`
}

type DiagnosticsResult struct {
	Ref string `json:"ref"`
}

type BlobReadParams struct {
	Ref    string `json:"ref"`
	Offset int    `json:"offset,omitempty"`
	Limit  int    `json:"limit,omitempty"`
}

type BlobReadResult struct {
	Data   []byte `json:"data"`
	Offset int    `json:"offset"`
	Total  int    `json:"total"`
}
