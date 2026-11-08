package tool

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"unicode/utf8"

	"github.com/TongTong313/merakcode/merak/engine/model"
)

// Execute bounds text output before the loop records it in history.
func Execute(ctx context.Context, t Tool, call Call) (Result, error) {
	result, err := t.Run(ctx, call)
	if err != nil {
		return result, err
	}
	var text []string
	var media []model.Part
	for _, part := range result.Parts {
		if part.Text != "" {
			text = append(text, part.Text)
		}
		if part.Image != nil || part.Document != nil {
			part.Text = ""
			media = append(media, part)
		}
	}
	body := strings.Join(text, "\n")
	lines := strings.Split(strings.TrimSuffix(body, "\n"), "\n")
	if len(body) <= 32768 && len(lines) <= 2000 {
		return result, nil
	}
	if call.Env.Spill == nil {
		return Result{}, errors.New("tool output requires blob storage")
	}
	ref, err := call.Env.Spill(ctx, call.Name, []byte(body))
	if err != nil {
		return Result{}, err
	}
	head := boundedUTF8(strings.Join(lines[:min(60, len(lines))], "\n"), false)
	tail := boundedUTF8(strings.Join(lines[max(0, len(lines)-20):], "\n"), true)
	preview := fmt.Sprintf("%s\n[Full output: %d lines. Read %s with lookup and a line range.]\n%s", head, len(lines), ref, tail)
	result.Parts = append([]model.Part{{Text: preview}}, media...)
	result.Truncated, result.Full = true, ref
	return result, nil
}

func boundedUTF8(text string, tail bool) string {
	if len(text) <= 8192 {
		return text
	}
	if tail {
		text = text[len(text)-8192:]
		for len(text) > 0 && !utf8.RuneStart(text[0]) {
			text = text[1:]
		}
		return text
	}
	text = text[:8192]
	for !utf8.ValidString(text) {
		text = text[:len(text)-1]
	}
	return text
}
