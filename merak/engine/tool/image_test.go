package tool_test

import (
	"bytes"
	"context"
	"encoding/json"
	"image"
	"image/png"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/TongTong313/merakcode/merak/engine/model"
	"github.com/TongTong313/merakcode/merak/engine/tool"
	"github.com/TongTong313/merakcode/merak/internal/testpdf"
)

func TestReadFileReturnsImageBytesInsteadOfBinaryText(t *testing.T) {
	var picture bytes.Buffer
	if err := png.Encode(&picture, image.NewRGBA(image.Rect(0, 0, 2, 2))); err != nil {
		t.Fatal(err)
	}
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "picture.bin"), picture.Bytes(), 0600); err != nil {
		t.Fatal(err)
	}
	result, err := tool.Execute(context.Background(), tool.ReadFile{}, tool.Call{Input: json.RawMessage(`{"path":"picture.bin"}`), Env: tool.Env{Workdir: dir}})
	if err != nil || result.IsError || len(result.Parts) != 1 || result.Parts[0].Image == nil {
		t.Fatalf("image result=%+v, %v", result, err)
	}
	if result.Parts[0].Text != "" || result.Parts[0].Image.MIME != "image/png" || !bytes.Equal(result.Parts[0].Image.Data, picture.Bytes()) {
		t.Fatalf("image=%+v", result.Parts[0])
	}
}

func TestReadFileExtractsTextFromPDF(t *testing.T) {
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "text.pdf"), testpdf.Unicode(), 0600); err != nil {
		t.Fatal(err)
	}
	result, err := tool.Execute(context.Background(), tool.ReadFile{}, tool.Call{Input: json.RawMessage(`{"path":"text.pdf"}`), Env: tool.Env{Workdir: dir}})
	if err != nil || result.IsError || len(result.Parts) != 1 || result.Parts[0].Text != "\u4e16\u754c" {
		t.Fatalf("PDF text missing: %+v error=%v", result, err)
	}
}

type illustratedOutput struct{}

func (illustratedOutput) Spec() tool.Spec { return tool.Spec{Name: "illustrated"} }
func (illustratedOutput) Run(context.Context, tool.Call) (tool.Result, error) {
	return tool.Result{Parts: []model.Part{{Text: strings.Repeat("line\n", 3000)}, {Image: &model.Image{MIME: "image/png", Data: []byte{1, 2, 3}}}}}, nil
}

func TestTruncatingTextRetainsToolImages(t *testing.T) {
	result, err := tool.Execute(context.Background(), illustratedOutput{}, tool.Call{Env: tool.Env{Spill: func(context.Context, string, []byte) (tool.Ref, error) { return "mrk://blob/output", nil }}})
	if err != nil || !result.Truncated || len(result.Parts) != 2 || result.Parts[1].Image == nil {
		t.Fatalf("media lost: %+v error=%v", result, err)
	}
}

func TestReadFileReturnsPDFDocument(t *testing.T) {
	dir := t.TempDir()
	body := []byte("%PDF-1.4\n%%EOF\n")
	if err := os.WriteFile(filepath.Join(dir, "document.pdf"), body, 0600); err != nil {
		t.Fatal(err)
	}
	result, err := tool.Execute(context.Background(), tool.ReadFile{}, tool.Call{Input: json.RawMessage(`{"path":"document.pdf"}`), Env: tool.Env{Workdir: dir}})
	if err != nil || result.IsError || len(result.Parts) != 1 || result.Parts[0].Document == nil {
		t.Fatalf("document=%+v error=%v", result, err)
	}
	document := result.Parts[0].Document
	if document.MIME != "application/pdf" || document.Name != "document.pdf" || !bytes.Equal(document.Data, body) {
		t.Fatalf("document=%+v", document)
	}
}
