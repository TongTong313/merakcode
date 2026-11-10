// Package workspace isolates claim changes and integrates them into the project.
package workspace

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"sync"

	"github.com/TongTong313/merakcode/merak/engine/event"
	"github.com/TongTong313/merakcode/merak/engine/store"
	"github.com/TongTong313/merakcode/merak/engine/task"
	"github.com/TongTong313/merakcode/merak/internal/platform/git"
)

type Kind = string

const KindWorktree Kind = "worktree"
const KindFolder Kind = "folder"
const KindInplace Kind = "inplace"
const KindNone Kind = "none"

type Workspace struct {
	SetupID   event.ID `json:"setupId,omitempty"`
	ID        event.ID `json:"id"`
	Kind      Kind     `json:"kind"`
	Group     event.ID `json:"group"`
	Task      event.ID `json:"task"`
	Claim     event.ID `json:"claim"`
	Member    event.ID `json:"member"`
	Project   string   `json:"project"`
	Directory string   `json:"directory"`
	Branch    string   `json:"branch"`
	Base      string   `json:"base"`
	Released  bool     `json:"released,omitempty"`
	Active    bool     `json:"active"`
	Pooled    bool     `json:"pooled,omitempty"`
}

type Integration struct {
	Workspace event.ID `json:"workspace"`
	Claim     event.ID `json:"claim"`
	Target    string   `json:"target"`
	Head      string   `json:"head,omitempty"`
	Conflicts []string `json:"conflicts,omitempty"`
	Commits   []string `json:"commits,omitempty"`
}

const (
	Created         event.Type = "workspace.created"
	Released        event.Type = "workspace.released"
	Idle            event.Type = "workspace.idle"
	Resumed         event.Type = "workspace.resumed"
	MergeQueued     event.Type = "merge.queued"
	MergeDone       event.Type = "merge.done"
	MergeConflicted event.Type = "merge.conflicted"
)

func init() {
	event.Register[Workspace](Created)
	event.Register[Workspace](Released)
	event.Register[Workspace](Idle)
	event.Register[Workspace](Resumed)
	for _, kind := range []event.Type{MergeQueued, MergeDone, MergeConflicted} {
		event.Register[Integration](kind)
	}
}

type Manager struct {
	mu      sync.Mutex
	store   store.Store
	bus     *event.Bus
	newID   func() event.ID
	cancel  context.CancelFunc
	ctx     context.Context
	queue   Queue
	changed chan struct{}
}

func New(ctx context.Context, storage store.Store, bus *event.Bus, newID func() event.ID) *Manager {
	ctx, cancel := context.WithCancel(ctx)
	return &Manager{store: storage, bus: bus, newID: newID, cancel: cancel, ctx: ctx, changed: make(chan struct{})}
}
func (m *Manager) Close() { m.cancel() }

func safeID(id event.ID) bool {
	if id == "" {
		return false
	}
	for _, r := range id {
		if !(r >= 'a' && r <= 'z' || r >= 'A' && r <= 'Z' || r >= '0' && r <= '9' || r == '-' || r == '_') {
			return false
		}
	}
	return true
}

func (m *Manager) forWorktree(ctx context.Context, project string, claim task.Claim, card task.Card) (Workspace, error) {
	if card.Workspace != KindWorktree || !safeID(card.ID) || !safeID(claim.Member) || claim.Task != card.ID || claim.ID == "" {
		return Workspace{}, errors.New("invalid worktree claim")
	}
	root, err := git.Root(ctx, project)
	if err != nil {
		return Workspace{}, err
	}
	projectInfo, err := os.Stat(project)
	if err != nil {
		return Workspace{}, err
	}
	rootInfo, err := os.Stat(root)
	if err != nil {
		return Workspace{}, err
	}
	if !os.SameFile(projectInfo, rootInfo) {
		return Workspace{}, errors.New("worktree projects must name the repository root")
	}
	parent := root
	for _, name := range []string{".merak", "worktrees"} {
		parent = filepath.Join(parent, name)
		if err := os.Mkdir(parent, 0700); err != nil && !os.IsExist(err) {
			return Workspace{}, err
		}
		resolved, err := filepath.EvalSymlinks(parent)
		if err != nil {
			return Workspace{}, err
		}
		rel, err := filepath.Rel(root, resolved)
		if err != nil || rel == ".." || strings.HasPrefix(rel, ".."+string(filepath.Separator)) {
			return Workspace{}, errors.New("worktree directory escapes the project")
		}
	}
	ws := Workspace{ID: m.newID(), Active: true, Kind: KindWorktree, Group: card.Group, Task: card.ID, Claim: claim.ID, Member: claim.Member, Project: root, Directory: filepath.Join(parent, string(card.ID)+"-"+string(claim.Member)), Branch: "merak/" + string(card.ID) + "/" + string(claim.Member), Base: card.Base}
	pooled, err := m.reusable(ctx, root)
	if err != nil {
		return Workspace{}, err
	}
	if pooled.ID != "" {
		if err := validatePooledPath(pooled); err != nil {
			return Workspace{}, err
		}
		if err := git.ReuseWorktree(ctx, pooled.Directory, pooled.Branch, ws.Branch, ws.Base); err != nil {
			return Workspace{}, err
		}
		pooled.Pooled = false
		if err := m.save(ctx, pooled); err != nil {
			return Workspace{}, err
		}
		ws.Directory = pooled.Directory
		ws.SetupID = pooled.SetupID
		if ws.SetupID == "" {
			ws.SetupID = pooled.ID
		}
		if err := m.save(ctx, ws); err != nil {
			return Workspace{}, err
		}
		return ws, m.emit(ctx, ws, Created, ws)
	}
	if _, err := os.Lstat(ws.Directory); !os.IsNotExist(err) {
		return Workspace{}, errors.New("worktree directory already exists or is inaccessible")
	}
	if err := git.ExcludeWorktrees(ctx, root); err != nil {
		return Workspace{}, err
	}
	if err := git.CreateBranch(ctx, root, ws.Branch, ws.Base); err != nil {
		return Workspace{}, err
	}
	if err := git.AddWorktree(ctx, root, ws.Directory, ws.Branch); err != nil {
		return Workspace{}, err
	}
	if err := m.save(ctx, ws); err != nil {
		return Workspace{}, err
	}
	if err := m.emit(ctx, ws, Created, ws); err != nil {
		return Workspace{}, err
	}
	return ws, nil
}

func (m *Manager) Get(ctx context.Context, id event.ID) (Workspace, error) {
	doc, err := m.store.Fetch(ctx, "workspace", string(id))
	if err != nil {
		return Workspace{}, err
	}
	var ws Workspace
	err = json.Unmarshal(doc.Body, &ws)
	return ws, err
}

func (m *Manager) save(ctx context.Context, ws Workspace) error {
	var revision uint64
	doc, err := m.store.Fetch(ctx, "workspace", string(ws.ID))
	if err == nil {
		revision = doc.Rev
	} else if !errors.Is(err, store.ErrNotFound) {
		return err
	}
	body, err := json.Marshal(ws)
	if err != nil {
		return err
	}
	return m.store.Put(ctx, store.Doc{Kind: "workspace", Key: string(ws.ID), Rev: revision, Body: body})
}

func (m *Manager) emit(ctx context.Context, ws Workspace, kind event.Type, value any) error {
	body, err := json.Marshal(value)
	if err != nil {
		return err
	}
	_, err = m.bus.Publish(ctx, event.Event{Stream: event.Stream("group:" + ws.Group), Scope: event.Scope{Group: ws.Group, Task: ws.Task}, Actor: event.Actor{Kind: event.ActorAgent, ID: ws.Member}, Type: kind, Payload: body})
	return err
}

// ObserveProject excludes a target update until its integration event is durable.
func (m *Manager) ObserveProject(ctx context.Context, project string, observe func(context.Context) error) error {
	return m.queue.Do(ctx, project, observe)
}

func (m *Manager) Integrate(ctx context.Context, workspace Workspace, target, check string) (Integration, error) {
	ws, err := m.Get(ctx, workspace.ID)
	if err != nil {
		return Integration{}, err
	}
	if ws.Released {
		return Integration{}, errors.New("workspace has been released")
	}
	result := Integration{Workspace: ws.ID, Claim: ws.Claim, Target: target}
	ctx, cancel := context.WithCancel(ctx)
	defer cancel()
	stop := context.AfterFunc(m.ctx, cancel)
	defer stop()
	if err := m.emit(ctx, ws, MergeQueued, result); err != nil {
		return result, err
	}
	err = m.queue.Do(ctx, ws.Project, func(ctx context.Context) error {
		var err error
		result, err = m.integrate(ctx, ws, target, check)
		return err
	})
	return result, err
}

func (m *Manager) integrate(ctx context.Context, ws Workspace, target, check string) (Integration, error) {
	result := Integration{Workspace: ws.ID, Claim: ws.Claim, Target: target}
	status, err := git.Status(ctx, ws.Directory)
	if err != nil {
		return result, err
	}
	if status.Branch != ws.Branch {
		return result, errors.New("workspace branch has changed")
	}
	base, err := git.Commit(ctx, ws.Project, "refs/heads/"+target)
	if err != nil {
		return result, err
	}
	result.Conflicts, err = git.Rebase(ctx, ws.Directory, base)
	if err != nil {
		return result, err
	}
	if len(result.Conflicts) > 0 {
		return result, m.emit(ctx, ws, MergeConflicted, result)
	}
	if check != "" {
		if err := runCheck(ctx, ws.Directory, check); err != nil {
			return result, err
		}
	}
	result.Head, err = git.Current(ctx, ws.Directory)
	if err != nil {
		return result, err
	}
	revisions, err := git.NewCommits(ctx, ws.Directory, git.Refs{Head: base}, git.Refs{Head: result.Head})
	if err != nil {
		return result, err
	}
	for _, revision := range revisions {
		result.Commits = append(result.Commits, revision.ID)
	}
	if err := git.FastForward(ctx, ws.Project, target, ws.Branch); err != nil {
		return result, err
	}
	return result, m.emit(ctx, ws, MergeDone, result)
}

func (m *Manager) Release(ctx context.Context, workspace Workspace) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	ws, err := m.Get(ctx, workspace.ID)
	if err != nil {
		return err
	}
	if ws.Released {
		return nil
	}
	if ws.Kind == KindFolder {
		if err := removeFolder(ws); err != nil {
			return err
		}
	} else if ws.Kind == KindWorktree {
		if err := validatePooledPath(ws); err != nil {
			return err
		}
		count, err := m.pooledCount(ctx, ws.Project)
		if err != nil {
			return err
		}
		if count < 2 {
			ws.Pooled = true
		} else if err := git.DiscardWorktree(ctx, ws.Project, ws.Directory); err != nil {
			return err
		}
	}
	ws.Released, ws.Active = true, false
	if err := m.save(ctx, ws); err != nil {
		return err
	}
	if err := m.emit(ctx, ws, Released, ws); err != nil {
		return err
	}
	close(m.changed)
	m.changed = make(chan struct{})
	return nil
}
