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

type RepoCommitParams struct {
	DirectoryParams
	Message string `json:"message"`
	// Paths are the files to commit; without them everything is committed.
	Paths []string `json:"paths,omitempty"`
}

type RepoCommitResult struct {
	Commit string `json:"commit"`
}

type RepoCommitMessageResult struct {
	Message string `json:"message"`
}

type WorktreeCreateParams struct {
	DirectoryParams
	// Key is chosen by the client; asking again with it returns the same worktree.
	Key    string `json:"key"`
	Branch string `json:"branch,omitempty"`
}

type WorktreePathParams struct {
	Path string `json:"path"`
}

type FileFindParams struct {
	DirectoryParams
	Query string `json:"query"`
	Limit int    `json:"limit,omitempty"`
}
