package pdf_test

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"testing"

	"github.com/TongTong313/merakcode/merak/internal/platform/pdf"
	"github.com/TongTong313/merakcode/merak/internal/testpdf"
)

func TestExtractsCompressedUnicodeText(t *testing.T) {
	text, err := pdf.Extract(context.Background(), testpdf.Unicode(), pdf.Limits{})
	if err != nil || text != "\u4e16\u754c" {
		t.Fatalf("text=%q error=%v", text, err)
	}
}

func TestRejectsCompressedIndexesBeforeUnboundedLibraryParsing(t *testing.T) {
	data := []byte("%PDF-1.5\n1 0 obj\n<< /Type /XRef /Size 999999999 /Length 0 >>\nstream\n\nendstream\nendobj\n")
	data = append(data, []byte(fmt.Sprintf("startxref\n%d\n%%%%EOF", len("%PDF-1.5\n")))...)
	_, err := pdf.Extract(context.Background(), data, pdf.Limits{})
	if !errors.Is(err, pdf.ErrInvalid) {
		t.Fatalf("error=%v", err)
	}
}

func TestExtractionBoundsInputDecodedStreamsTextAndPages(t *testing.T) {
	for _, test := range []struct {
		name   string
		data   []byte
		limits pdf.Limits
	}{
		{"input", testpdf.Unicode(), pdf.Limits{InputBytes: 100}},
		{"decompressed stream", testpdf.Build(strings.Repeat(" ", 100000)+"BT /F1 12 Tf <00010002> Tj ET", 1), pdf.Limits{DecodedBytes: 4096}},
		{"cumulative text", testpdf.Build("BT /F1 12 Tf <00010002> Tj ET", 3), pdf.Limits{TextBytes: 10}},
		{"pages", testpdf.Build("BT /F1 12 Tf <00010002> Tj ET", 3), pdf.Limits{Pages: 2}},
	} {
		t.Run(test.name, func(t *testing.T) {
			text, err := pdf.Extract(context.Background(), test.data, test.limits)
			if !errors.Is(err, pdf.ErrLimit) || text != "" {
				t.Fatalf("text=%q error=%v", text, err)
			}
		})
	}
}
