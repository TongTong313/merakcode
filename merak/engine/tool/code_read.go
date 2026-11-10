package tool

import (
	"context"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"regexp"
	"strings"

	"github.com/TongTong313/merakcode/merak/engine/model"
	"github.com/TongTong313/merakcode/merak/internal/platform/pathglob"
)

// ReadCode is the file-only entry point used inside a device's sandbox process.
func ReadCode(ctx context.Context, directory string, call Call) (Result, error) {
	denied := Result{IsError: true, Code: "MRK-5002", Parts: []model.Part{{Text: "Only checkout reads are allowed."}}}
	if call.Name != "read_file" && call.Name != "grep" && call.Name != "glob" && call.Name != "list_dir" {
		return denied, nil
	}
	var input struct {
		Path    string `json:"path"`
		Pattern string `json:"pattern"`
	}
	if err := decodeInput(call.Input, &input); err != nil {
		return failure(err), nil
	}
	if input.Path == "" {
		if call.Name == "read_file" {
			return failure(errors.New("path is required")), nil
		}
		input.Path = "."
	}
	if !filepath.IsLocal(input.Path) {
		return denied, nil
	}
	root, err := os.OpenRoot(directory)
	if err != nil {
		return failure(err), nil
	}
	defer root.Close()
	if err = ctx.Err(); err != nil {
		return Result{}, err
	}
	if call.Name == "read_file" {
		file, err := root.Open(input.Path)
		if err != nil {
			return failure(err), nil
		}
		defer file.Close()
		info, err := file.Stat()
		if err != nil {
			return failure(err), nil
		}
		if !info.Mode().IsRegular() || info.Size() > 4<<20 {
			return failure(errors.New("file exceeds the device read limit")), nil
		}
		data, err := io.ReadAll(io.LimitReader(file, (4<<20)+1))
		if err != nil {
			return failure(err), nil
		}
		if len(data) > 4<<20 {
			return failure(errors.New("file exceeds the device read limit")), nil
		}
		return fileParts(ctx, filepath.Base(input.Path), data), nil
	}
	if call.Name == "list_dir" {
		entries, err := fs.ReadDir(root.FS(), filepath.ToSlash(input.Path))
		if err != nil {
			return failure(err), nil
		}
		names := []string{}
		for _, entry := range entries {
			name := entry.Name()
			if entry.IsDir() {
				name += "/"
			}
			names = append(names, name)
		}
		return Result{Parts: []model.Part{{Text: strings.Join(names, "\n")}}}, nil
	}
	if input.Pattern == "" {
		return failure(errors.New("pattern is required")), nil
	}
	var match func(string) bool
	if call.Name == "grep" {
		expression, err := regexp.Compile(input.Pattern)
		if err != nil {
			return failure(err), nil
		}
		match = expression.MatchString
	} else {
		expression, err := pathglob.Compile(input.Pattern)
		if err != nil {
			return failure(err), nil
		}
		match = expression.Match
	}
	var lines []string
	err = fs.WalkDir(root.FS(), filepath.ToSlash(input.Path), func(path string, entry fs.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		if err := ctx.Err(); err != nil {
			return err
		}
		if !entry.Type().IsRegular() {
			return nil
		}
		if len(lines) >= 10000 {
			return fs.SkipAll
		}
		if call.Name == "glob" {
			if match(path) {
				lines = append(lines, path)
			}
			return nil
		}
		info, err := entry.Info()
		if err != nil {
			return err
		}
		if info.Size() > 4<<20 {
			return nil
		}
		data, err := fs.ReadFile(root.FS(), path)
		if err != nil {
			return err
		}
		for index, line := range strings.Split(string(data), "\n") {
			if match(line) {
				lines = append(lines, fmt.Sprintf("%s:%d:%s", path, index+1, line))
				if len(lines) >= 10000 {
					return fs.SkipAll
				}
			}
		}
		return nil
	})
	if err != nil {
		return failure(err), nil
	}
	return Result{Parts: []model.Part{{Text: strings.Join(lines, "\n")}}}, nil
}
