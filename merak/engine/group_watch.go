package engine

import (
	"context"
	"encoding/json"
	"time"

	"github.com/TongTong313/merakcode/merak/engine/event"
	"github.com/TongTong313/merakcode/merak/engine/group"
	"github.com/TongTong313/merakcode/merak/engine/store"
	"github.com/TongTong313/merakcode/merak/engine/workspace"
	"github.com/TongTong313/merakcode/merak/internal/platform/git"
	"github.com/TongTong313/merakcode/merak/internal/platform/watch"
)

const (
	RepoChanged     event.Type = "repo.changed"
	FileChanged     event.Type = "file.changed"
	SentinelFlagged event.Type = "sentinel.flagged"
)

type WatchOverload struct {
	Rule      string `json:"rule"`
	Code      string `json:"code"`
	Directory string `json:"directory"`
	watch.Overload
}

type FileChanges struct {
	Directory string              `json:"directory"`
	Paths     []string            `json:"paths"`
	Claims    map[string]event.ID `json:"claims,omitempty"`
}

type RepoChanges struct {
	watch.RepoChanged
	Claims map[string]event.ID `json:"claims,omitempty"`
}

func init() {
	event.Register[RepoChanges](RepoChanged)
	event.Register[FileChanges](FileChanged)
	event.Register[WatchOverload](SentinelFlagged)
}

func (e *Engine) watchGroup(ctx context.Context, g group.Group) error {
	changes, stop := e.Bus.Subscribe(event.Filter{Types: []event.Type{workspace.Created, workspace.Resumed, workspace.Idle, workspace.Released}})
	excluded, err := e.watchedWorkspaces(ctx)
	if err != nil {
		stop()
		return err
	}
	files := watch.NewFiles(g.Project.Directory, excluded)
	initial, err := files.Poll(ctx)
	if err != nil {
		stop()
		return err
	}
	if err := e.reportWatchOverload(ctx, g, initial.Overload); err != nil {
		stop()
		return err
	}
	var repository *watch.Repository
	if g.Brief.TargetBranch != "" {
		var err error
		repository, err = watch.NewRepository(ctx, g.Project.Directory, g.Brief.TargetBranch)
		if err != nil {
			stop()
			return err
		}
	}
	e.workers.Go(func() {
		defer stop()
		ticker := time.NewTicker(5 * time.Second)
		defer ticker.Stop()
		var recent []string
		record := func(fact event.Event) {
			ws, err := event.Decode[workspace.Workspace](fact)
			if err == nil && ws.Kind != workspace.KindNone {
				recent = append(recent, ws.Directory)
			}
		}
		for {
			select {
			case <-e.ctx.Done():
				return
			case fact, ok := <-changes:
				if !ok {
					return
				}
				record(fact)
			case <-ticker.C:
			drain:
				for {
					select {
					case fact, ok := <-changes:
						if !ok {
							return
						}
						record(fact)
					default:
						break drain
					}
				}
				excluded, err := e.watchedWorkspaces(e.ctx)
				if err != nil {
					continue
				}
				files.SetExcluded(append(excluded, recent...))
				var changed *watch.RepoChanged
				if repository != nil {
					changed, _ = repository.Poll(e.ctx)
				}
				scan, err := files.Poll(e.ctx)
				if err == nil {
					recent = nil
					_ = e.reportWatchOverload(e.ctx, g, scan.Overload)
				}
				var owned map[string]event.ID
				if changed != nil || len(scan.Paths) > 0 {
					owned = e.integratedCommits(e.ctx, g.ID, g.Project.Directory)
				}
				if changed != nil {
					claims := map[string]event.ID{}
					for _, commit := range changed.Commits {
						if owner := owned[commit.ID]; owner != "" {
							claims[commit.ID] = owner
						}
					}
					_ = e.environmentEvent(e.ctx, g.ID, RepoChanged, RepoChanges{RepoChanged: *changed, Claims: claims})
				}
				if err == nil && len(scan.Paths) > 0 {
					claims := e.integratedFiles(e.ctx, g.Project.Directory, scan.Paths, owned)
					_ = e.environmentEvent(e.ctx, g.ID, FileChanged, FileChanges{Directory: g.Project.Directory, Paths: scan.Paths, Claims: claims})
				}
			}
		}
	})
	return nil
}

func (e *Engine) watchedWorkspaces(ctx context.Context) ([]string, error) {
	docs, err := e.store.List(ctx, "workspace", "")
	if err != nil {
		return nil, err
	}
	var directories []string
	for _, doc := range docs {
		ws, err := e.Workspaces.Get(ctx, event.ID(doc.Key))
		if err != nil {
			return nil, err
		}
		if ws.Released || ws.Kind == workspace.KindNone || ws.Kind == workspace.KindInplace && !ws.Active {
			continue
		}
		directories = append(directories, ws.Directory)
	}
	return directories, nil
}

func (e *Engine) reportWatchOverload(ctx context.Context, g group.Group, overload *watch.Overload) error {
	if overload == nil {
		return nil
	}
	body, err := json.Marshal(WatchOverload{Rule: "watch.overload", Code: "MRK-1005", Directory: g.Project.Directory, Overload: *overload})
	if err != nil {
		return err
	}
	fact, err := e.Bus.Publish(ctx, event.Event{Stream: event.Stream("group:" + g.ID), Scope: event.Scope{Group: g.ID}, Actor: event.Actor{Kind: "system"}, Type: SentinelFlagged, Payload: body})
	if err != nil {
		return err
	}
	state, err := e.Groups.Get(ctx, g.ID)
	if err != nil {
		return err
	}
	var to []event.ID
	for _, member := range state.Members {
		if member.Can(group.RoleOwner) {
			to = append(to, member.ID)
		}
	}
	body, err = json.Marshal(group.Notice{Kind: "info", Text: "MRK-1005", To: to})
	if err != nil {
		return err
	}
	_, err = e.Bus.Publish(ctx, event.Event{Stream: fact.Stream, Scope: fact.Scope, Actor: fact.Actor, Type: group.NoticeSent, Cause: fact.ID, Payload: body})
	return err
}

func (e *Engine) integratedCommits(ctx context.Context, groupID event.ID, directory string) map[string]event.ID {
	owned := map[string]event.ID{}
	if marked, err := git.ClaimCommits(ctx, directory); err == nil {
		if cards, err := e.Tasks.List(ctx, groupID); err == nil {
			known := map[event.ID]bool{}
			for _, card := range cards {
				for _, claim := range card.Claims {
					known[claim.ID] = true
				}
			}
			for commit, claim := range marked {
				if known[event.ID(claim)] {
					owned[commit] = event.ID(claim)
				}
			}
		}
	}
	facts, err := e.store.Find(ctx, store.Query{Scope: event.Scope{Group: groupID}, Types: []event.Type{workspace.MergeDone}})
	if err != nil {
		return owned
	}
	for _, fact := range facts {
		merged, err := event.Decode[workspace.Integration](fact)
		if err != nil {
			continue
		}
		for _, commit := range merged.Commits {
			owned[commit] = merged.Claim
		}
	}
	return owned
}

func (e *Engine) integratedFiles(ctx context.Context, directory string, paths []string, owned map[string]event.ID) map[string]event.ID {
	if len(owned) == 0 {
		return nil
	}
	ctx, cancel := context.WithTimeout(ctx, time.Second)
	defer cancel()
	status, err := git.Status(ctx, directory)
	if err != nil {
		return nil
	}
	dirty := map[string]bool{}
	for _, file := range status.Files {
		dirty[file.Path], dirty[file.OldPath] = true, true
	}
	claims := map[string]event.ID{}
	for _, name := range paths {
		if dirty[name] {
			continue
		}
		commit, err := git.LastChange(ctx, directory, name)
		if err != nil {
			break
		}
		if claim := owned[commit]; claim != "" {
			claims[name] = claim
		}
	}
	return claims
}

func (e *Engine) environmentEvent(ctx context.Context, groupID event.ID, kind event.Type, payload any) error {
	body, err := json.Marshal(payload)
	if err != nil {
		return err
	}
	_, err = e.Bus.Publish(ctx, event.Event{Stream: event.Stream("group:" + groupID), Scope: event.Scope{Group: groupID}, Actor: event.Actor{Kind: event.ActorExternal}, Type: kind, Payload: body})
	return err
}
