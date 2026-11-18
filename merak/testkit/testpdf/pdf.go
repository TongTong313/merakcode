// Package testpdf builds small, real PDF fixtures for package integration tests.
package testpdf

import (
	"bytes"
	"compress/zlib"
	"fmt"
	"strings"
)

func Unicode() []byte { return Build("BT /F1 12 Tf 10 50 Td <00010002> Tj ET", 1) }

// Build shares a compressed content stream across the requested pages.
func Build(content string, pages int) []byte {
	var compressed bytes.Buffer
	writer := zlib.NewWriter(&compressed)
	_, _ = writer.Write([]byte(content))
	_ = writer.Close()
	cmap := "/CIDInit /ProcSet findresource begin 12 dict begin begincmap /CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def /CMapName /Test def /CMapType 2 def 1 begincodespacerange <0000> <ffff> endcodespacerange 2 beginbfchar <0001> <4e16> <0002> <754c> endbfchar endcmap CMapName currentdict /CMap defineresource pop end end"
	var kids bytes.Buffer
	for i := range pages {
		fmt.Fprintf(&kids, "%d 0 R ", 7+i)
	}
	objects := []string{
		"<< /Type /Catalog /Pages 2 0 R >>",
		fmt.Sprintf("<< /Type /Pages /Count %d /Kids [%s] >>", pages, kids.String()),
		"<< /Type /Font /Subtype /Type0 /BaseFont /Test /Encoding /Identity-H /DescendantFonts [6 0 R] /ToUnicode 5 0 R >>",
		fmt.Sprintf("<< /Length %d /Filter /FlateDecode >>\nstream\n%s\nendstream", compressed.Len(), compressed.String()),
		fmt.Sprintf("<< /Length %d >>\nstream\n%s\nendstream", len(cmap), cmap),
		"<< /Type /Font /Subtype /CIDFontType2 /BaseFont /Test /CIDSystemInfo << /Registry (Adobe) /Ordering (Identity) /Supplement 0 >> /DW 1000 >>",
	}
	image := ""
	if strings.Contains(content, "/Scan Do") {
		image = fmt.Sprintf(" /XObject << /Scan %d 0 R >>", 7+pages)
	}
	for range pages {
		objects = append(objects, "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 100 100] /Resources << /Font << /F1 3 0 R >>"+image+" >> /Contents 4 0 R >>")
	}
	if image != "" {
		objects = append(objects, "<< /Type /XObject /Subtype /Image /Width 1 /Height 1 /ColorSpace /DeviceGray /BitsPerComponent 8 /Length 1 >>\nstream\n\x80\nendstream")
	}
	var pdf bytes.Buffer
	pdf.WriteString("%PDF-1.4\n")
	var offsets []int
	for i, object := range objects {
		offsets = append(offsets, pdf.Len())
		fmt.Fprintf(&pdf, "%d 0 obj\n%s\nendobj\n", i+1, object)
	}
	xref := pdf.Len()
	fmt.Fprintf(&pdf, "xref\n0 %d\n0000000000 65535 f \n", len(objects)+1)
	for _, offset := range offsets {
		fmt.Fprintf(&pdf, "%010d 00000 n \n", offset)
	}
	fmt.Fprintf(&pdf, "trailer\n<< /Size %d /Root 1 0 R >>\nstartxref\n%d\n%%%%EOF\n", len(objects)+1, xref)
	return pdf.Bytes()
}
