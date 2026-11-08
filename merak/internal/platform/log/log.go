// Package log configures structured process diagnostics.
package log

import (
	"fmt"
	"log/slog"
	"os"
	"path/filepath"
	"time"

	"github.com/TongTong313/merakcode/merak/engine/event"
)

type Options struct {
	Dir       string
	Level     slog.Level
	LevelVar  *slog.LevelVar
	MaxBytes  int64
	MaxFiles  int
	Component string
}

func New(o Options) (*slog.Logger, func() error, error) {
	if err := os.MkdirAll(o.Dir, 0o700); err != nil {
		return nil, nil, err
	}
	name := fmt.Sprintf("%d-%d.ndjson", os.Getpid(), time.Now().UnixNano())
	filename := filepath.Join(o.Dir, name)
	file, err := os.OpenFile(filename, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o600)
	if err != nil {
		return nil, nil, err
	}
	if o.MaxBytes <= 0 {
		o.MaxBytes = 20 << 20
	}
	if o.MaxFiles <= 0 || o.MaxFiles > 5 {
		o.MaxFiles = 5
	}
	output := &rotating{file: file, path: filename, maxBytes: o.MaxBytes, maxFiles: o.MaxFiles}
	var level slog.Leveler = o.Level
	if o.LevelVar != nil {
		level = o.LevelVar
	}
	logger := slog.New(&handler{output: output, level: level, component: o.Component})
	return logger, output.Close, nil
}

func With(logger *slog.Logger, scope event.Scope) *slog.Logger {
	return logger.With("session", string(scope.Session), "group", string(scope.Group), "task", string(scope.Task))
}

func Root() (string, error) {
	home := os.Getenv("MERAKCODE_HOME")
	if home == "" {
		userHome, err := os.UserHomeDir()
		if err != nil {
			return "", err
		}
		home = filepath.Join(userHome, ".merakcode")
	}
	return filepath.Join(home, "logs"), nil
}

func Directory(component string, development bool) (string, error) {
	root, err := Root()
	if err != nil {
		return "", err
	}
	mode := "production"
	if development {
		mode = "development"
	}
	return filepath.Join(root, mode, component), nil
}
