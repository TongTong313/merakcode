// Package rules manages project rule files.
package rules

import (
	"errors"
	"os"
	"path/filepath"

	agentrules "github.com/TongTong313/merakcode/merak/engine/agent/rules"
)

// WriteFile creates or replaces the rule file of a project and returns its path.
func WriteFile(root, name, text string) (string, error) {
	file, err := agentrules.RuleFile(root, name)
	if err != nil {
		return "", err
	}
	if len(text) > 256*1024 {
		return "", errors.New("the rule is too large")
	}
	if err := os.MkdirAll(filepath.Dir(file), 0o755); err != nil {
		return "", err
	}
	return file, os.WriteFile(file, []byte(text), 0o644)
}

// DeleteFile removes the rule file of a project.
func DeleteFile(root, name string) error {
	file, err := agentrules.RuleFile(root, name)
	if err != nil {
		return err
	}
	return os.Remove(file)
}
