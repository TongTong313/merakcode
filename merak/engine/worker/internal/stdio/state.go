package stdio

import (
	"crypto/rand"
	"errors"
	"io"
	"os"
	"path/filepath"
	"slices"

	"github.com/TongTong313/merakcode/merak/internal/platform/sandbox"
)

func ProductState(p sandbox.Profile, names ...string) (sandbox.Profile, error) {
	p.EnvAllow = append(append([]string(nil), p.EnvAllow...), "HOME", "USERPROFILE", "APPDATA", "LOCALAPPDATA", "SystemRoot", "PATH")
	home, err := os.UserHomeDir()
	if err != nil {
		return p, err
	}
	for _, name := range names {
		if err := sandbox.PrepareStateDirectory(filepath.Join(home, name)); err != nil {
			return p, err
		}
		path, err := productStatePath(filepath.Join(home, name))
		if err != nil {
			return p, err
		}
		p.WriteAllow = append(p.WriteAllow, path)
	}
	for _, name := range []string{".claude", ".claude.json", ".codex", ".pi", ".config/opencode", ".local/share/opencode"} {
		if slices.Contains(names, name) {
			continue
		}
		path, err := productStatePath(filepath.Join(home, name))
		if err != nil {
			return p, err
		}
		p.ReadDeny = append(p.ReadDeny, path)
		p.TransientReadDeny = append(p.TransientReadDeny, path)
	}
	return p, nil
}

func productStatePath(path string) (string, error) {
	resolved, err := filepath.EvalSymlinks(path)
	if err == nil {
		return resolved, nil
	}
	parent := filepath.Dir(path)
	if !os.IsNotExist(err) || parent == path {
		return "", err
	}
	resolved, err = productStatePath(parent)
	if err != nil {
		return "", err
	}
	return filepath.Join(resolved, filepath.Base(path)), nil
}

func ClaudeState(p sandbox.Profile, configured string) (sandbox.Profile, string, error) {
	p, err := ProductState(p, ".claude")
	if err != nil {
		return p, "", err
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return p, "", err
	}
	if configured == "" {
		configured = os.Getenv("CLAUDE_CONFIG_DIR")
	}
	if configured == "" {
		configured = filepath.Join(home, ".claude")
	}
	directory, err := filepath.Abs(configured)
	if err != nil {
		return p, "", err
	}
	if directory == filepath.Clean(home) || filepath.Dir(directory) == directory {
		return p, "", errors.New("Claude state directory cannot be the user home or filesystem root")
	}
	if err := sandbox.PrepareStateDirectory(directory); err != nil {
		return p, "", err
	}
	directory, err = filepath.EvalSymlinks(directory)
	if err != nil {
		return p, "", err
	}
	realHome, err := filepath.EvalSymlinks(home)
	if err != nil {
		return p, "", err
	}
	if directory == realHome || filepath.Dir(directory) == directory {
		return p, "", errors.New("Claude state directory cannot resolve to the user home or filesystem root")
	}
	if err := copyClaudeConfiguration(filepath.Join(home, ".claude.json"), filepath.Join(directory, ".claude.json")); err != nil {
		return p, "", err
	}
	if !slices.Contains(p.WriteAllow, directory) {
		p.WriteAllow = append(p.WriteAllow, directory)
	}
	configuration := filepath.Join(directory, ".claude.json")
	if _, err := os.Stat(configuration); err == nil {
		p.WriteAllow = append(p.WriteAllow, configuration)
	} else if !os.IsNotExist(err) {
		return p, "", err
	}
	p.EnvAllow = append(p.EnvAllow, "CLAUDE_CONFIG_DIR")
	return p, directory, nil
}

func copyClaudeConfiguration(source, destination string) error {
	if _, err := os.Stat(destination); err == nil {
		return nil
	} else if !os.IsNotExist(err) {
		return err
	}
	input, err := os.Open(source)
	if os.IsNotExist(err) {
		return nil
	}
	if err != nil {
		return err
	}
	defer input.Close()
	pending := filepath.Join(filepath.Dir(destination), ".claude-migration-"+rand.Text())
	output, err := sandbox.CreateStateFile(pending)
	if err != nil {
		return err
	}
	defer os.Remove(pending)
	_, copyErr := io.Copy(output, input)
	if err := errors.Join(copyErr, output.Close()); err != nil {
		return err
	}
	// Linking publishes a complete private file without replacing a concurrent migration.
	if err := os.Link(pending, destination); !os.IsExist(err) {
		return err
	}
	return nil
}
