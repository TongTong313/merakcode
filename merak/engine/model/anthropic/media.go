package anthropic

import (
	"encoding/base64"
	"errors"
	"strings"
	"unicode/utf8"

	"github.com/TongTong313/merakcode/merak/engine/model"
	sdk "github.com/anthropics/anthropic-sdk-go/v2"
)

func contentBlock(part model.Part) (sdk.ContentBlockParamUnion, error) {
	if part.Image != nil {
		picture := part.Image
		if picture.URL != "" {
			return sdk.NewImageBlock(sdk.URLImageSourceParam{URL: picture.URL}), nil
		}
		return sdk.NewImageBlockBase64(picture.MIME, base64.StdEncoding.EncodeToString(picture.Data)), nil
	}
	if part.Document != nil {
		doc := part.Document
		var block sdk.ContentBlockParamUnion
		switch {
		case doc.MIME == "application/pdf":
			block = sdk.NewDocumentBlock(sdk.Base64PDFSourceParam{Data: base64.StdEncoding.EncodeToString(doc.Data)})
		case strings.HasPrefix(doc.MIME, "text/") && utf8.Valid(doc.Data):
			block = sdk.NewDocumentBlock(sdk.PlainTextSourceParam{Data: string(doc.Data)})
		default:
			return block, errors.New("unsupported document media type")
		}
		block.OfDocument.Title = sdk.String(doc.Name)
		return block, nil
	}
	return sdk.NewTextBlock(part.Text), nil
}
