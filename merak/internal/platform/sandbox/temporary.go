package sandbox

import (
	"os"
	"path/filepath"
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
	cleanup := func() { _ = os.RemoveAll(created) }
	private, err = filepath.EvalSymlinks(private)
	if err != nil {
		cleanup()
		return p, nil, err
	}
	p.PrivateDirectory = private
	p.WriteAllow = append(append([]string(nil), p.WriteAllow...), private)
	return p, cleanup, nil
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
