package tool

import (
	"archive/zip"
	"bytes"
	"context"
	"encoding/json"
	"encoding/xml"
	"errors"
	"io"
	"os"
	"path/filepath"
	"strings"

	"github.com/TongTong313/merakcode/merak/engine/model"
)

const maxOfficeFile = 32 << 20

// DocxRead reads a Word document: headings, paragraphs and tables, in order, as plain text.
type DocxRead struct{}

func (DocxRead) Spec() Spec {
	return Spec{Name: "docx_read", Description: "Read a .docx document: headings as #, paragraphs, and table rows joined by \" | \".", Effect: EffectRead,
		Input: json.RawMessage(`{"type":"object","properties":{"path":{"type":"string","minLength":1}},"required":["path"],"additionalProperties":false}`)}
}

func (DocxRead) Run(ctx context.Context, call Call) (Result, error) {
	if err := ctx.Err(); err != nil {
		return Result{}, err
	}
	var input struct {
		Path string `json:"path"`
	}
	if err := decodeInput(call.Input, &input); err != nil {
		return failure(err), nil
	}
	archive, err := openOffice(call.Env.Workdir, input.Path, ".docx")
	if err != nil {
		return failure(err), nil
	}
	defer archive.Close()
	body, err := readEntry(&archive.ReadCloser.Reader, "word/document.xml")
	if err != nil {
		return failure(errors.New("this is not a Word document")), nil
	}
	text, err := docxText(body)
	if err != nil {
		return failure(err), nil
	}
	return Result{Parts: []model.Part{{Text: text}}}, nil
}

type officeFile struct {
	*zip.ReadCloser
}

func openOffice(workdir, name, extension string) (*officeFile, error) {
	if name == "" {
		return nil, errors.New("path is required")
	}
	if !strings.EqualFold(filepath.Ext(name), extension) {
		return nil, errors.New("the file must be a " + extension + " file")
	}
	path := name
	if !filepath.IsAbs(path) {
		path = filepath.Join(workdir, path)
	}
	info, err := os.Stat(path)
	if err != nil {
		return nil, err
	}
	if info.Size() > maxOfficeFile {
		return nil, errors.New("the file is too large")
	}
	reader, err := zip.OpenReader(path)
	if err != nil {
		return nil, errors.New("the file is not a valid " + extension + " package")
	}
	return &officeFile{ReadCloser: reader}, nil
}

func readEntry(archive *zip.Reader, name string) ([]byte, error) {
	for _, file := range archive.File {
		if file.Name != name {
			continue
		}
		opened, err := file.Open()
		if err != nil {
			return nil, err
		}
		defer opened.Close()
		body, err := io.ReadAll(io.LimitReader(opened, maxOfficeFile+1))
		if err != nil || len(body) > maxOfficeFile {
			return nil, errors.New("a part of the package is too large")
		}
		return body, nil
	}
	return nil, os.ErrNotExist
}

// docxText turns word/document.xml into text. Headings come out as # lines, table rows as cells joined by " | ".
func docxText(document []byte) (string, error) {
	decoder := xml.NewDecoder(bytes.NewReader(document))
	var out []string
	var paragraph strings.Builder
	heading, inTable, inCell := 0, false, false
	var row, cells []string
	var cell []string
	flushParagraph := func() {
		line := paragraph.String()
		paragraph.Reset()
		if inCell {
			if strings.TrimSpace(line) != "" {
				cell = append(cell, strings.TrimSpace(line))
			}
			return
		}
		if strings.TrimSpace(line) == "" {
			heading = 0
			return
		}
		if heading > 0 {
			line = strings.Repeat("#", heading) + " " + strings.TrimSpace(line)
		}
		out = append(out, line)
		heading = 0
	}
	for {
		token, err := decoder.Token()
		if err == io.EOF {
			break
		}
		if err != nil {
			return "", errors.New("the document could not be read")
		}
		switch element := token.(type) {
		case xml.StartElement:
			switch element.Name.Local {
			case "pStyle":
				for _, attribute := range element.Attr {
					if attribute.Name.Local == "val" && strings.HasPrefix(strings.ToLower(attribute.Value), "heading") {
						level := strings.TrimPrefix(strings.ToLower(attribute.Value), "heading")
						if len(level) == 1 && level[0] >= '1' && level[0] <= '6' {
							heading = int(level[0] - '0')
						}
					}
				}
			case "br", "cr":
				paragraph.WriteByte('\n')
			case "tab":
				paragraph.WriteByte('\t')
			case "tbl":
				inTable = true
			case "tr":
				cells = nil
			case "tc":
				inCell, cell = true, nil
			case "t":
				var value string
				if err := decoder.DecodeElement(&value, &element); err != nil {
					return "", errors.New("the document could not be read")
				}
				paragraph.WriteString(value)
			}
		case xml.EndElement:
			switch element.Name.Local {
			case "p":
				flushParagraph()
			case "tc":
				cells = append(cells, strings.Join(cell, " "))
				inCell = false
			case "tr":
				row = cells
				out = append(out, strings.Join(row, " | "))
			case "tbl":
				inTable = false
			}
		}
	}
	_ = inTable
	return strings.Join(out, "\n"), nil
}
