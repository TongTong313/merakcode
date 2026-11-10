package sandbox

import (
	"os"
	"path/filepath"
	"slices"
)

func (l *Launcher) privateProfile(p Profile) (Profile, func(), error) {
	root := l.StateDir
	if root != "" {
		if err := os.MkdirAll(root, 0700); err != nil {
			return p, nil, err
		}
	}
	private, err := os.MkdirTemp(root, "member-")
	if err != nil {
		return p, nil, err
	}
	created := private
	cleanup := func() {
		l.mu.Lock()
		delete(l.privateDirectories, private)
		l.mu.Unlock()
		_ = os.RemoveAll(created)
	}
	private, err = filepath.EvalSymlinks(private)
	if err != nil {
		cleanup()
		return p, nil, err
	}
	p.PrivateDirectory = private
	l.mu.Lock()
	if l.privateDirectories == nil {
		l.privateDirectories = make(map[string]struct{})
	}
	l.privateDirectories[private] = struct{}{}
	l.mu.Unlock()
	p.WriteAllow = append(append([]string(nil), p.WriteAllow...), private)
	return p, cleanup, nil
}

// PackageCaches returns only cache directories belonging to this launcher's live processes.
func (l *Launcher) PackageCaches() []string {
	l.mu.Lock()
	defer l.mu.Unlock()
	var paths []string
	for directory := range l.privateDirectories {
		for _, name := range []string{"npm", "pnpm", "yarn", "pip", "uv", "go-build", "go-mod"} {
			paths = append(paths, filepath.Join(directory, name))
		}
	}
	slices.Sort(paths)
	return paths
}

func privateEnvironment(directory string) []string {
	return []string{
		"TEMP=" + directory, "TMP=" + directory, "TMPDIR=" + directory,
		"npm_config_cache=" + filepath.Join(directory, "npm"),
		"npm_config_store_dir=" + filepath.Join(directory, "pnpm"),
		"YARN_CACHE_FOLDER=" + filepath.Join(directory, "yarn"),
		"PIP_CACHE_DIR=" + filepath.Join(directory, "pip"),
		"UV_CACHE_DIR=" + filepath.Join(directory, "uv"),
		"GOCACHE=" + filepath.Join(directory, "go-build"),
		"GOMODCACHE=" + filepath.Join(directory, "go-mod"),
	}
}
