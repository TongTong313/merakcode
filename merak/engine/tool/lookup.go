package tool

import (
	"context"
	"encoding/json"
	"errors"
	"net/url"
	"strconv"
	"strings"

	"github.com/TongTong313/merakcode/merak/engine/model"
	"github.com/TongTong313/merakcode/merak/engine/store"
)

type Lookup struct {
	Store    store.Store
	Resolve  func(context.Context, *url.URL) ([]byte, error)
	MaxBytes int
}

func (Lookup) Spec() Spec {
	return Spec{Name: "lookup", Description: "Read a permitted mrk:// reference, optionally selecting one-based inclusive startLine and endLine, or ?lines=start-end.", Effect: EffectRead,
		Input: json.RawMessage(`{"type":"object","properties":{"ref":{"type":"string"},"startLine":{"type":"integer","minimum":1},"endLine":{"type":"integer","minimum":1}},"required":["ref"],"additionalProperties":false}`)}
}

func (l Lookup) Run(ctx context.Context, call Call) (Result, error) {
	var input struct {
		Ref   string `json:"ref"`
		Start *int   `json:"startLine"`
		End   *int   `json:"endLine"`
	}
	if err := decodeInput(call.Input, &input); err != nil {
		return failure(err), nil
	}
	ref, err := url.Parse(input.Ref)
	if err != nil || ref.Scheme != "mrk" || ref.User != nil || ref.Path == "" || l.Resolve == nil && (ref.Host != "blob" || ref.Fragment != "") {
		return failure(errors.New("expected a mrk://blob reference")), nil
	}
	key := strings.TrimPrefix(ref.Path, "/")
	if key == "" || l.Resolve == nil && strings.Contains(key, "/") {
		return failure(errors.New("invalid blob key")), nil
	}
	query, err := url.ParseQuery(ref.RawQuery)
	if err != nil || len(query) > 1 || len(query) == 1 && len(query["lines"]) != 1 {
		return failure(errors.New("invalid reference query")), nil
	}
	if value := query.Get("lines"); value != "" {
		if input.Start != nil || input.End != nil {
			return failure(errors.New("provide the line range only once")), nil
		}
		first, last, ok := strings.Cut(value, "-")
		start, errStart := strconv.Atoi(first)
		end, errEnd := strconv.Atoi(last)
		if !ok || errStart != nil || errEnd != nil {
			return failure(errors.New("invalid line range")), nil
		}
		input.Start, input.End = &start, &end
	}
	var data []byte
	if l.Resolve != nil {
		data, err = l.Resolve(ctx, ref)
	} else {
		var doc store.Doc
		doc, err = l.Store.Fetch(ctx, "blob", key)
		data = doc.Body
	}
	if err != nil {
		return failure(err), nil
	}
	lines := strings.Split(strings.TrimSuffix(string(data), "\n"), "\n")
	start, end := 1, len(lines)
	if input.Start != nil {
		start = *input.Start
	}
	if input.End != nil {
		end = *input.End
	}
	if start < 1 || end < start || start > len(lines) {
		return failure(errors.New("invalid line range")), nil
	}
	text := strings.Join(lines[start-1:min(end, len(lines))], "\n")
	if l.MaxBytes > 0 && len(text) > l.MaxBytes {
		text = text[:l.MaxBytes] + "\n[Result truncated; request a narrower line range.]"
	}
	return Result{Parts: []model.Part{{Text: text}}}, nil
}
