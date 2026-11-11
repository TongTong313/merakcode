package workspace

import (
	"errors"
	"os"
	"strings"
)

// Existing says whether a folder can be the workspace of a conversation or a group: it is named and it exists.
func Existing(directory string) error {
	if strings.TrimSpace(directory) == "" {
		return errors.New("a workspace folder is required")
	}
	info, err := os.Stat(directory)
	if err != nil {
		return errors.New("the workspace folder does not exist")
	}
	if !info.IsDir() {
		return errors.New("the workspace is not a folder")
	}
	return nil
}
