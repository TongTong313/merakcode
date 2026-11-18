package model

import (
	"context"
	"strings"
)

const blobPrefix = "mrk://blob/"

// Blobs wraps a provider so that an image kept as a mrk://blob reference goes out as its bytes: no provider can read
// the reference itself. The stored messages are not changed; the request carries copies. A reference whose bytes
// cannot be read fails the request.
type Blobs struct {
	Provider Provider
	// Read returns the bytes stored under the key of a reference.
	Read func(ctx context.Context, key string) ([]byte, error)
}

func (b Blobs) Name() string { return b.Provider.Name() }

func (b Blobs) Stream(ctx context.Context, req Request) (Stream, error) {
	messages := make([]Message, len(req.Messages))
	for i, message := range req.Messages {
		parts, err := b.resolve(ctx, message.Parts)
		if err != nil {
			return nil, err
		}
		messages[i] = Message{Role: message.Role, Parts: parts}
	}
	req.Messages = messages
	return b.Provider.Stream(ctx, req)
}

func (b Blobs) resolve(ctx context.Context, parts []Part) ([]Part, error) {
	resolved := make([]Part, len(parts))
	for i, part := range parts {
		resolved[i] = part
		if part.Image != nil && strings.HasPrefix(part.Image.URL, blobPrefix) {
			data, err := b.Read(ctx, strings.TrimPrefix(part.Image.URL, blobPrefix))
			if err != nil {
				return nil, err
			}
			resolved[i].Image = &Image{MIME: part.Image.MIME, Data: data}
		}
		if part.ToolResult != nil {
			inner, err := b.resolve(ctx, part.ToolResult.Parts)
			if err != nil {
				return nil, err
			}
			result := *part.ToolResult
			result.Parts = inner
			resolved[i].ToolResult = &result
		}
	}
	return resolved, nil
}
