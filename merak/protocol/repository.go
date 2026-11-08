package protocol

import "github.com/TongTong313/merakcode/merak/engine/event"

type DirectoryParams struct {
	Directory string `json:"directory,omitempty"`
}
type FileParams struct {
	DirectoryParams
	Path string `json:"path"`
}
type RepoDiffParams struct {
	DirectoryParams
	Base    string   `json:"base,omitempty"`
	Session event.ID `json:"session,omitempty"`
}
type RepoCheckoutParams struct {
	DirectoryParams
	Branch string `json:"branch"`
}
