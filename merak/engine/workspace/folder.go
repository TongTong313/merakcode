package workspace

import (
	"context"
	"errors"
	"io"
	"os"
	"path/filepath"

	"github.com/TongTong313/merakcode/merak/engine/event"
	"github.com/TongTong313/merakcode/merak/engine/store"
	"github.com/TongTong313/merakcode/merak/engine/task"
	"github.com/TongTong313/merakcode/merak/engine/tool"
)

const ArtifactPublished event.Type = "artifact.published"

type Published struct {
	ID        event.ID `json:"id"`
	Workspace event.ID `json:"workspace"`
	Claim     event.ID `json:"claim"`
	Path      string   `json:"path"`
	Title     string   `json:"title"`
	MediaType string   `json:"mediaType,omitempty"`
}

func init() { event.Register[Published](ArtifactPublished) }

func (m *Manager) forFolder(ctx context.Context, project string, claim task.Claim, card task.Card) (Workspace, error) {
	if !safeID(card.ID) || !safeID(claim.Member) || claim.Task != card.ID || claim.ID == "" {
		return Workspace{}, errors.New("invalid folder claim")
	}
	project, err := filepath.Abs(project)
	if err != nil {
		return Workspace{}, err
	}
	project, err = filepath.EvalSymlinks(project)
	if err != nil {
		return Workspace{}, err
	}
	root, err := os.OpenRoot(project)
	if err != nil {
		return Workspace{}, err
	}
	defer root.Close()
	parent := filepath.Join(".merak", "work")
	if err := root.MkdirAll(parent, 0700); err != nil {
		return Workspace{}, err
	}
	relative := filepath.Join(parent, string(card.ID)+"-"+string(claim.Member))
	if err := root.Mkdir(relative, 0700); err != nil {
		return Workspace{}, err
	}
	complete := false
	defer func() {
		if !complete {
			_ = root.RemoveAll(relative)
		}
	}()
	destination, err := root.OpenRoot(relative)
	if err != nil {
		return Workspace{}, err
	}
	defer destination.Close()
	for _, name := range card.Inputs {
		if err := ctx.Err(); err != nil {
			return Workspace{}, err
		}
		body, err := readRegular(root, name)
		if err != nil {
			return Workspace{}, err
		}
		if err := destination.MkdirAll(filepath.Dir(name), 0700); err != nil {
			return Workspace{}, err
		}
		if err := destination.WriteFile(name, body, 0600); err != nil {
			return Workspace{}, err
		}
	}
	ws := Workspace{ID: m.newID(), Active: true, Kind: KindFolder, Group: card.Group, Task: card.ID, Claim: claim.ID, Member: claim.Member, Project: project, Directory: filepath.Join(project, relative)}
	if err := m.save(ctx, ws); err != nil {
		return Workspace{}, err
	}
	if err := m.emit(ctx, ws, Created, ws); err != nil {
		return Workspace{}, err
	}
	complete = true
	return ws, nil
}

func readRegular(root *os.Root, name string) ([]byte, error) {
	if !filepath.IsLocal(name) {
		return nil, errors.New("file must be relative to the workspace")
	}
	file, err := root.Open(name)
	if err != nil {
		return nil, err
	}
	defer file.Close()
	info, err := file.Stat()
	if err != nil {
		return nil, err
	}
	if !info.Mode().IsRegular() {
		return nil, errors.New("only regular files can be copied")
	}
	return io.ReadAll(file)
}

func (m *Manager) Publish(ctx context.Context, workspace Workspace, artifacts []tool.Artifact) ([]event.ID, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	ws, err := m.Get(ctx, workspace.ID)
	if err != nil {
		return nil, err
	}
	if ws.Kind != KindFolder || ws.Released || len(artifacts) == 0 {
		return nil, errors.New("publication requires a live folder workspace and declared artifacts")
	}
	project, err := os.OpenRoot(ws.Project)
	if err != nil {
		return nil, err
	}
	defer project.Close()
	relative, err := filepath.Rel(ws.Project, ws.Directory)
	if err != nil {
		return nil, err
	}
	source, err := project.OpenRoot(relative)
	if err != nil {
		return nil, err
	}
	defer source.Close()
	var ids []event.ID
	for _, artifact := range artifacts {
		if err := ctx.Err(); err != nil {
			return ids, err
		}
		body, err := readRegular(source, artifact.Path)
		if err != nil {
			return ids, err
		}
		id := m.newID()
		path := filepath.Join(string(id), filepath.Clean(artifact.Path))
		file := filepath.Join(".merak", "artifacts", string(ws.Task), path)
		if err := project.MkdirAll(filepath.Dir(file), 0700); err != nil {
			return ids, err
		}
		if err := project.WriteFile(file, body, 0600); err != nil {
			return ids, err
		}
		if err := m.store.Put(ctx, store.Doc{Kind: "blob", Key: string(id), Body: body, Meta: map[string]string{"title": artifact.Title, "path": filepath.ToSlash(path), "mediaType": artifact.MediaType, "group": string(ws.Group)}}); err != nil {
			return ids, err
		}
		published := Published{ID: id, Workspace: ws.ID, Claim: ws.Claim, Path: filepath.ToSlash(path), Title: artifact.Title, MediaType: artifact.MediaType}
		if err := m.emit(ctx, ws, ArtifactPublished, published); err != nil {
			return ids, err
		}
		ids = append(ids, id)
	}
	return ids, nil
}

func removeFolder(ws Workspace) error {
	name := filepath.Join(".merak", "work", string(ws.Task)+"-"+string(ws.Member))
	if !safeID(ws.Task) || !safeID(ws.Member) || filepath.Clean(ws.Directory) != filepath.Join(ws.Project, name) {
		return errors.New("invalid folder workspace path")
	}
	root, err := os.OpenRoot(ws.Project)
	if err != nil {
		return err
	}
	defer root.Close()
	return root.RemoveAll(name)
}
