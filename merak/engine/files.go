package engine

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"unicode/utf8"

	"github.com/TongTong313/merakcode/merak/engine/event"
	"github.com/TongTong313/merakcode/merak/engine/tool"
	"github.com/TongTong313/merakcode/merak/internal/platform/git"
)

type FileContent struct {
	Type    string `json:"type"`
	Content string `json:"content"`
	MIME    string `json:"mime,omitempty"`
}

type FileNode struct {
	Name string `json:"name"`
	Path string `json:"path"`
	Type string `json:"type"`
}

func (e *Engine) directory(directory string) string {
	if directory == "" {
		return e.workdir
	}
	return directory
}

func (e *Engine) ReadFile(ctx context.Context, directory, path string) (FileContent, error) {
	input, _ := json.Marshal(map[string]string{"path": path})
	result, err := (tool.ReadFile{}).Run(ctx, tool.Call{Input: input, Env: tool.Env{Workdir: e.directory(directory)}})
	if err != nil {
		return FileContent{}, err
	}
	if result.IsError {
		return FileContent{}, errors.New("file read failed")
	}
	content := FileContent{Type: "text"}
	for _, part := range result.Parts {
		if part.Image != nil {
			return FileContent{Type: "binary", MIME: part.Image.MIME, Content: base64.StdEncoding.EncodeToString(part.Image.Data)}, nil
		}
		if part.Document != nil {
			return FileContent{Type: "binary", MIME: part.Document.MIME, Content: base64.StdEncoding.EncodeToString(part.Document.Data)}, nil
		}
		if !utf8.ValidString(part.Text) {
			return FileContent{Type: "binary"}, nil
		}
		content.Content += part.Text
	}
	return content, nil
}

func (e *Engine) ListFiles(ctx context.Context, directory, path string) ([]FileNode, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	directory = e.directory(directory)
	absolute := path
	if !filepath.IsAbs(path) {
		absolute = filepath.Join(directory, path)
	}
	entries, err := os.ReadDir(absolute)
	if err != nil {
		return nil, err
	}
	result := []FileNode{}
	for _, entry := range entries {
		if entry.Name() == ".git" {
			continue
		}
		node := FileNode{Name: entry.Name(), Path: filepath.ToSlash(filepath.Join(path, entry.Name())), Type: "file"}
		if entry.IsDir() {
			node.Type = "directory"
		}
		result = append(result, node)
	}
	return result, nil
}

func (e *Engine) RepoStatus(ctx context.Context, directory string) (git.State, error) {
	return git.Status(ctx, e.directory(directory))
}

func (e *Engine) RepoBranches(ctx context.Context, directory string) ([]git.Branch, error) {
	return git.Branches(ctx, e.directory(directory))
}

func (e *Engine) RepoCheckout(ctx context.Context, directory, branch string) error {
	return git.Checkout(ctx, e.directory(directory), branch)
}

func (e *Engine) RepoDiff(ctx context.Context, directory, base string, sessionID event.ID) ([]git.Change, error) {
	if sessionID != "" {
		if base != "" {
			return nil, errors.New("choose a session or a commit")
		}
		state, err := e.SessionSnapshot(ctx, sessionID)
		if err != nil {
			return nil, err
		}
		base = state.BaseCommit
		directory = state.Config.Workdir
	}
	return git.Diff(ctx, e.directory(directory), base)
}
