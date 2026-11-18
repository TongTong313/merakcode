// Package pdf extracts bounded text without exposing PDF library types.
package pdf

import (
	"bytes"
	"context"
	"errors"
	"io"
	"strings"

	reader "github.com/ledongthuc/pdf"
)

type Limits struct{ InputBytes, DecodedBytes, TextBytes, Pages int }

var ErrLimit = errors.New("PDF extraction limit exceeded")
var ErrInvalid = errors.New("invalid or unsupported PDF")
var ErrNoText = errors.New("PDF has no extractable text")

func Extract(ctx context.Context, data []byte, limits Limits) (text string, err error) {
	defer func() {
		if recover() != nil {
			text, err = "", ErrInvalid
		}
	}()
	if limits.InputBytes <= 0 {
		limits.InputBytes = 16 << 20
	}
	if limits.DecodedBytes <= 0 {
		limits.DecodedBytes = 16 << 20
	}
	if limits.TextBytes <= 0 {
		limits.TextBytes = 4 << 20
	}
	if limits.Pages <= 0 {
		limits.Pages = 500
	}
	if len(data) > limits.InputBytes {
		return "", ErrLimit
	}
	if err := ctx.Err(); err != nil {
		return "", err
	}
	if err := checkIndex(data); err != nil {
		return "", err
	}
	document, err := reader.NewReader(bytes.NewReader(data), int64(len(data)))
	if err != nil {
		return "", ErrInvalid
	}
	pages, err := collectPages(document.Trailer().Key("Root").Key("Pages"), limits.Pages, 0)
	if err != nil {
		return "", err
	}
	var output strings.Builder
	remaining := limits.DecodedBytes
	for _, current := range pages {
		if err := ctx.Err(); err != nil {
			return "", err
		}
		if err := checkStream(ctx, current.V.Key("Contents"), &remaining); err != nil {
			return "", err
		}
		fonts := make(map[string]*reader.Font)
		resources, err := pageResources(current.V)
		if err != nil {
			return "", err
		}
		resources = resources.Key("Font")
		for _, name := range resources.Keys() {
			font := &reader.Font{V: resources.Key(name)}
			if err := checkStream(ctx, font.V.Key("ToUnicode"), &remaining); err != nil {
				return "", err
			}
			fonts[name] = font
		}
		value, err := current.GetPlainText(fonts)
		if err != nil {
			return "", ErrInvalid
		}
		if len(value) > limits.TextBytes-output.Len() {
			return "", ErrLimit
		}
		output.WriteString(value)
	}
	text = strings.TrimSpace(output.String())
	if text == "" {
		return "", ErrNoText
	}
	return text, nil
}

func collectPages(value reader.Value, left, depth int) ([]reader.Page, error) {
	if left <= 0 || depth > 32 {
		return nil, ErrLimit
	}
	if value.Key("Type").Name() == "Page" {
		return []reader.Page{{V: value}}, nil
	}
	if value.Key("Type").Name() != "Pages" {
		return nil, ErrInvalid
	}
	kids := value.Key("Kids")
	if kids.Len() > left {
		return nil, ErrLimit
	}
	var pages []reader.Page
	for i := 0; i < kids.Len(); i++ {
		found, err := collectPages(kids.Index(i), left-len(pages), depth+1)
		if err != nil {
			return nil, err
		}
		pages = append(pages, found...)
	}
	return pages, nil
}

func pageResources(value reader.Value) (reader.Value, error) {
	for depth := 0; depth < 32; depth++ {
		resources := value.Key("Resources")
		if resources.Kind() != reader.Null {
			return resources, nil
		}
		value = value.Key("Parent")
		if value.Kind() == reader.Null {
			return value, nil
		}
	}
	return reader.Value{}, ErrLimit
}

// checkStream stops decompression before extraction can consume an oversized stream.
func checkStream(ctx context.Context, value reader.Value, remaining *int) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	if value.Kind() == reader.Array {
		if value.Len() > 10000 {
			return ErrLimit
		}
		for i := 0; i < value.Len(); i++ {
			if err := checkStream(ctx, value.Index(i), remaining); err != nil {
				return err
			}
		}
		return nil
	}
	if value.Kind() == reader.Null {
		return nil
	}
	if value.Kind() != reader.Stream {
		return ErrInvalid
	}
	// Nested filter chains and predictors cannot be bounded through this library's API.
	filter := value.Key("Filter")
	if filter.Kind() != reader.Null && filter.Kind() != reader.Name {
		return ErrInvalid
	}
	if filter.Kind() == reader.Name && filter.Name() != "FlateDecode" && filter.Name() != "ASCII85Decode" {
		return ErrInvalid
	}
	if value.Key("DecodeParms").Kind() != reader.Null {
		return ErrInvalid
	}
	stream := value.Reader()
	defer stream.Close()
	count, err := io.Copy(io.Discard, io.LimitReader(stream, int64(*remaining)+1))
	if err != nil {
		return ErrInvalid
	}
	if count > int64(*remaining) {
		return ErrLimit
	}
	*remaining -= int(count)
	return nil
}
