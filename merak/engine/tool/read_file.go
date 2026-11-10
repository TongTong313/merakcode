package tool

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"os"
	"path/filepath"

	"github.com/TongTong313/merakcode/merak/engine/memory"
	"github.com/TongTong313/merakcode/merak/engine/model"
	"github.com/TongTong313/merakcode/merak/internal/platform/pdf"
)

type ReadFile struct{ Memory memory.Recall }

func (ReadFile) Spec() Spec {
	return Spec{
		Name: "read_file", Description: "Read a file relative to the working directory, or by absolute path.",
		Input:  json.RawMessage(`{"type":"object","properties":{"path":{"type":"string","minLength":1}},"required":["path"],"additionalProperties":false}`),
		Effect: EffectRead,
	}
}

func (r ReadFile) Run(ctx context.Context, call Call) (result Result, runErr error) {
	if err := ctx.Err(); err != nil {
		return Result{}, err
	}
	var input struct {
		Path string `json:"path"`
	}
	decoder := json.NewDecoder(bytes.NewReader(call.Input))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&input); err != nil {
		return failure(err), nil
	}
	if err := decoder.Decode(new(any)); err != io.EOF {
		return failure(errors.New("expected one JSON object")), nil
	}
	if input.Path == "" {
		return failure(errors.New("path is required")), nil
	}
	path := input.Path
	if !filepath.IsAbs(path) {
		path = filepath.Join(call.Env.Workdir, path)
	}
	defer func() {
		if r.Memory == nil || runErr != nil || result.IsError {
			return
		}
		tags := []string{filepath.ToSlash(filepath.Clean(path))}
		if relative, err := filepath.Rel(call.Env.Workdir, path); err == nil {
			tags = append(tags, filepath.ToSlash(relative))
		}
		notes, err := r.Memory.Recall(ctx, memory.Query{Owners: call.Env.MemoryOwners, Tags: tags, Limit: 5})
		if err == nil && len(notes) > 0 {
			result.Parts = append(result.Parts, model.Part{Text: memory.Format(notes)})
		}
	}()
	data, err := os.ReadFile(path)
	if err != nil {
		return failure(err), nil
	}
	call.Env.Reads.remember(path, data)
	return fileParts(ctx, path, data), nil
}

func fileParts(ctx context.Context, path string, data []byte) Result {
	mime := http.DetectContentType(data)
	if mime == "image/png" || mime == "image/jpeg" || mime == "image/webp" || mime == "image/gif" {
		return Result{Parts: []model.Part{{Image: &model.Image{MIME: mime, Data: data}}}}
	}
	if mime == "application/pdf" {
		if text, err := pdf.Extract(ctx, data, pdf.Limits{}); err == nil {
			return Result{Parts: []model.Part{{Text: text}}}
		}
		return Result{Parts: []model.Part{{Document: &model.Document{MIME: mime, Name: filepath.Base(path), Data: data}}}}
	}
	return Result{Parts: []model.Part{{Text: string(data)}}}
}
