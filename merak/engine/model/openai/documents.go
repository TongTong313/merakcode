package openai

import (
	"context"
	"slices"
	"strings"
	"unicode/utf8"

	"github.com/TongTong313/merakcode/merak/engine/model"
	"github.com/TongTong313/merakcode/merak/internal/platform/pdf"
)

func prepareDocuments(ctx context.Context, request model.Request, nativePDF bool) (model.Request, []model.Chunk) {
	var dropped []model.Chunk
	var parts func([]model.Part) []model.Part
	parts = func(input []model.Part) []model.Part {
		result := make([]model.Part, 0, len(input))
		for _, part := range input {
			if doc := part.Document; doc != nil && !(nativePDF && doc.MIME == "application/pdf") {
				dropped = append(dropped, model.Chunk{Kind: model.DroppedChunk, Dropped: "document"})
				var text string
				switch {
				case strings.HasPrefix(doc.MIME, "text/") && utf8.Valid(doc.Data):
					text = string(doc.Data)
				case doc.MIME == "application/pdf":
					text, _ = pdf.Extract(ctx, doc.Data, pdf.Limits{})
				}
				if text != "" {
					result = append(result, model.Part{Text: text})
				}
				continue
			}
			if part.ToolResult != nil {
				copy := *part.ToolResult
				copy.Parts = parts(copy.Parts)
				part.ToolResult = &copy
			}
			result = append(result, part)
		}
		return result
	}
	request.Messages = slices.Clone(request.Messages)
	for i := range request.Messages {
		request.Messages[i].Parts = parts(request.Messages[i].Parts)
	}
	return request, dropped
}
