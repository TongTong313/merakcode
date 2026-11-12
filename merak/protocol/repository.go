package protocol

import (
	"github.com/TongTong313/merakcode/merak/engine/event"
	"github.com/TongTong313/merakcode/merak/engine/review"
)

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
	// Message limits a session review to the turn of that user message; "last" is the latest turn.
	Message event.ID `json:"message,omitempty"`
}

// ReviewDecideParams accepts or rejects files of the review of a conversation.
type ReviewDecideParams struct {
	Session event.ID `json:"session"`
	// Message names the turn the files belong to; empty is the whole conversation and "last" the latest turn.
	Message event.ID      `json:"message,omitempty"`
	Files   []review.File `json:"files"`
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
	// Staged commits what the index holds and nothing else; it takes no paths.
	Staged bool `json:"staged,omitempty"`
}

type RepoPathsParams struct {
	DirectoryParams
	Paths []string `json:"paths"`
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
	// Base is the branch the worktree starts from; the current head when empty.
	Base string `json:"base,omitempty"`
}

type WorktreePathParams struct {
	Path string `json:"path"`
}

type FileFindParams struct {
	DirectoryParams
	Query string `json:"query"`
	Limit int    `json:"limit,omitempty"`
}

type FileWriteParams struct {
	FileParams
	Content string `json:"content"`
	// Checksum is the version of the file the client read; the write is refused when the file no longer has it.
	Checksum string `json:"checksum,omitempty"`
	// Force writes over any version.
	Force bool `json:"force,omitempty"`
}

type FileWriteResult struct {
	Checksum string `json:"checksum"`
}
