package coordinator

import (
	"context"
	"encoding/json"
	"time"

	"github.com/TongTong313/merakcode/merak/engine/collab/group"
	"github.com/TongTong313/merakcode/merak/engine/collab/leader"
	"github.com/TongTong313/merakcode/merak/engine/collab/workspace"
	"github.com/TongTong313/merakcode/merak/engine/infra/event"
	"github.com/TongTong313/merakcode/merak/engine/infra/git"
	"github.com/TongTong313/merakcode/merak/engine/infra/store"
	"github.com/TongTong313/merakcode/merak/engine/infra/watch"
)

const (
	RepoChanged     event.Type = "repo.changed"
	FileChanged     event.Type = "file.changed"
	SentinelFlagged event.Type = "sentinel.flagged"
)

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
	event.Register[leader.Finding](SentinelFlagged)
}

func (domain *Coordinator) watchGroup(ctx context.Context, g group.Group) error {
	changes, stop := domain.core.Bus.Subscribe(event.Filter{Types: []event.Type{workspace.Created, workspace.Resumed, workspace.Idle, workspace.Released}})
	excluded, err := domain.WatchedWorkspaces(ctx)
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
	if err := domain.reportWatchOverload(ctx, g, initial.Overload); err != nil {
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
	domain.core.Workers.Go(func() {
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
			case <-domain.core.Ctx.Done():
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
				excluded, err := domain.WatchedWorkspaces(domain.core.Ctx)
				if err != nil {
					continue
				}
				files.SetExcluded(append(excluded, recent...))
				_ = domain.workspaces.ObserveProject(domain.core.Ctx, g.Project.Directory, func(ctx context.Context) error {
					var changed *watch.RepoChanged
					if repository != nil {
						changed, _ = repository.Poll(domain.core.Ctx)
					}
					scan, err := files.Poll(domain.core.Ctx)
					if err == nil {
						recent = nil
						_ = domain.reportWatchOverload(domain.core.Ctx, g, scan.Overload)
					}
					var owned map[string]event.ID
					if changed != nil || len(scan.Paths) > 0 {
						owned = domain.integratedCommits(domain.core.Ctx, g.ID, g.Project.Directory)
					}
					if changed != nil {
						claims := map[string]event.ID{}
						for _, commit := range changed.Commits {
							if owner := owned[commit.ID]; owner != "" {
								claims[commit.ID] = owner
							}
						}
						_ = domain.environmentEvent(domain.core.Ctx, g.ID, RepoChanged, RepoChanges{RepoChanged: *changed, Claims: claims})
					}
					if err == nil && len(scan.Paths) > 0 {
						claims := domain.integratedFiles(domain.core.Ctx, g.Project.Directory, scan.Paths, owned)
						_ = domain.environmentEvent(domain.core.Ctx, g.ID, FileChanged, FileChanges{Directory: g.Project.Directory, Paths: scan.Paths, Claims: claims})
					}
					return nil
				})
			}
		}
	})
	return nil
}

func (domain *Coordinator) WatchedWorkspaces(ctx context.Context) ([]string, error) {
	docs, err := domain.core.Store.List(ctx, "workspace", "")
	if err != nil {
		return nil, err
	}
	var directories []string
	for _, doc := range docs {
		ws, err := domain.workspaces.Get(ctx, event.ID(doc.Key))
		if err != nil {
			return nil, err
		}
		if ws.Released && !ws.Pooled || ws.Kind == workspace.KindNone || ws.Kind == workspace.KindInplace && !ws.Active {
			continue
		}
		directories = append(directories, ws.Directory)
	}
	return directories, nil
}

func (domain *Coordinator) reportWatchOverload(ctx context.Context, g group.Group, overload *watch.Overload) error {
	if overload == nil {
		return nil
	}
	findings := leader.Inspect(leader.SentinelView{Watch: []leader.WatchView{{Files: overload.Files, Duration: overload.Duration}}})
	for _, finding := range findings {
		finding.Directory, finding.Files, finding.Duration = g.Project.Directory, overload.Files, overload.Duration
		if err := domain.flagFinding(ctx, g.ID, finding); err != nil {
			return err
		}
	}
	return nil
}
func (domain *Coordinator) integratedCommits(ctx context.Context, groupID event.ID, directory string) map[string]event.ID {
	owned := map[string]event.ID{}
	if marked, err := git.ClaimCommits(ctx, directory); err == nil {
		if cards, err := domain.tasks.List(ctx, groupID); err == nil {
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
	facts, err := domain.core.Store.Find(ctx, store.Query{Scope: event.Scope{Group: groupID}, Types: []event.Type{workspace.MergeDone}})
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

func (domain *Coordinator) integratedFiles(ctx context.Context, directory string, paths []string, owned map[string]event.ID) map[string]event.ID {
	if len(owned) == 0 {
		return nil
	}
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

func (domain *Coordinator) environmentEvent(ctx context.Context, groupID event.ID, kind event.Type, payload any) error {
	body, err := json.Marshal(payload)
	if err != nil {
		return err
	}
	_, err = domain.core.Bus.Publish(ctx, event.Event{Stream: event.Stream("group:" + groupID), Scope: event.Scope{Group: groupID}, Actor: event.Actor{Kind: event.ActorExternal}, Type: kind, Payload: body})
	return err
}
