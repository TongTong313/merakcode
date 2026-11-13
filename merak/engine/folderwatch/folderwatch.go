// Package folderwatch looks at the folders that clients asked to watch and reports what changes in them without the
// engine having done it: a checkout or a commit, and the files that changed.
package folderwatch

import (
	"context"
	"sync"
	"time"

	"github.com/TongTong313/merakcode/merak/internal/platform/watch"
)

// DefaultInterval is how often a watched folder is looked at.
const DefaultInterval = 2 * time.Second

// Hooks connect the watchers to the engine that owns them.
type Hooks struct {
	// Context ends every watcher; it is the lifetime of the engine.
	Context context.Context
	// Go starts a goroutine the engine waits for when it closes.
	Go func(func())
	// Excluded names the folders whose changes the engine makes itself and so does not report as outside changes.
	Excluded func(ctx context.Context) []string
	// Repository reports a checkout or a commit of a folder.
	Repository func(ctx context.Context, directory string, changed watch.RepoChanged)
	// Files reports the paths that changed in a folder.
	Files func(ctx context.Context, directory string, paths []string)
}

type folder struct {
	owners map[string]bool
	stop   context.CancelFunc
}

// Watches keeps the watchers that clients asked for; the zero value is ready to use.
type Watches struct {
	mu       sync.Mutex
	byFolder map[string]*folder
	interval time.Duration
}

// SetInterval changes how often a watched folder is looked at; tests make it short.
func (w *Watches) SetInterval(interval time.Duration) {
	w.mu.Lock()
	defer w.mu.Unlock()
	w.interval = interval
}

// Watch starts watching a folder for an owner. Asking again for a folder that is already watched adds an owner and does
// not start a second watcher. The starting point is taken before it returns, so whatever changes after the caller is
// told is reported.
func (w *Watches) Watch(ctx context.Context, hooks Hooks, owner, directory string) error {
	if w.addOwner(owner, directory) {
		return nil
	}
	var excluded []string
	if hooks.Excluded != nil {
		excluded = hooks.Excluded(ctx)
	}
	files := watch.NewFiles(directory, excluded)
	if _, err := files.Poll(ctx); err != nil {
		return err
	}
	// A folder that is not a Git repository has no repository to watch; its files are still watched.
	repository, _ := watch.NewRepository(ctx, directory, "")

	w.mu.Lock()
	defer w.mu.Unlock()
	if existing := w.byFolder[directory]; existing != nil {
		existing.owners[owner] = true
		return nil
	}
	if w.byFolder == nil {
		w.byFolder = make(map[string]*folder)
	}
	runCtx, stop := context.WithCancel(hooks.Context)
	w.byFolder[directory] = &folder{owners: map[string]bool{owner: true}, stop: stop}
	interval := w.interval
	if interval <= 0 {
		interval = DefaultInterval
	}
	hooks.Go(func() { run(runCtx, hooks, directory, interval, files, repository) })
	return nil
}

func (w *Watches) addOwner(owner, directory string) bool {
	w.mu.Lock()
	defer w.mu.Unlock()
	existing := w.byFolder[directory]
	if existing == nil {
		return false
	}
	existing.owners[owner] = true
	return true
}

// Unwatch lets go of every folder the owner watches; a folder nobody watches any more is not looked at.
func (w *Watches) Unwatch(owner string) {
	w.mu.Lock()
	defer w.mu.Unlock()
	for directory, watcher := range w.byFolder {
		delete(watcher.owners, owner)
		if len(watcher.owners) == 0 {
			watcher.stop()
			delete(w.byFolder, directory)
		}
	}
}

func run(ctx context.Context, hooks Hooks, directory string, interval time.Duration, files *watch.Files, repository *watch.Repository) {
	ticker := time.NewTicker(interval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
		}
		if repository != nil {
			if changed, err := repository.Poll(ctx); err == nil && changed != nil {
				hooks.Repository(ctx, directory, *changed)
			}
		}
		if scan, err := files.Poll(ctx); err == nil && len(scan.Paths) > 0 {
			hooks.Files(ctx, directory, scan.Paths)
		}
	}
}
