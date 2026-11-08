package tool

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"regexp"
	"strings"

	"github.com/TongTong313/merakcode/merak/engine/model"
)

type Grep struct{}

func (Grep) Spec() Spec {
	return Spec{Name: "grep", Description: "Search file contents by regular expression. Returns path, line number, and matching line.", Effect: EffectRead,
		Input: json.RawMessage(`{"type":"object","properties":{"pattern":{"type":"string","minLength":1},"path":{"type":"string"}},"required":["pattern"],"additionalProperties":false}`)}
}

func (Grep) Run(ctx context.Context, call Call) (Result, error) {
	var input struct {
		Pattern string `json:"pattern"`
		Path    string `json:"path"`
	}
	if err := decodeInput(call.Input, &input); err != nil {
		return failure(err), nil
	}
	if input.Pattern == "" {
		return failure(errors.New("pattern is required")), nil
	}
	pattern, err := regexp.Compile(input.Pattern)
	if err != nil {
		return failure(err), nil
	}
	root := resolvePath(call.Env.Workdir, input.Path)
	var matches []string
	err = filepath.WalkDir(root, func(name string, entry fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if err := ctx.Err(); err != nil {
			return err
		}
		if !entry.Type().IsRegular() {
			return nil
		}
		file, err := os.Open(name)
		if err != nil {
			return err
		}
		defer file.Close()
		relative, err := filepath.Rel(call.Env.Workdir, name)
		if err != nil {
			return err
		}
		scanner := bufio.NewScanner(file)
		scanner.Buffer(make([]byte, 64*1024), 4*1024*1024)
		for line := 1; scanner.Scan(); line++ {
			if err := ctx.Err(); err != nil {
				return err
			}
			if pattern.MatchString(scanner.Text()) {
				matches = append(matches, fmt.Sprintf("%s:%d:%s", filepath.ToSlash(relative), line, scanner.Text()))
			}
		}
		return scanner.Err()
	})
	if err != nil {
		return failure(err), nil
	}
	return Result{Parts: []model.Part{{Text: strings.Join(matches, "\n")}}}, nil
}
