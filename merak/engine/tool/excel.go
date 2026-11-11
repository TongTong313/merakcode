package tool

import (
	"archive/zip"
	"bytes"
	"context"
	"encoding/json"
	"encoding/xml"
	"errors"
	"fmt"
	"io"
	"os"
	"path"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"github.com/TongTong313/merakcode/merak/engine/model"
)

// ExcelRead reads the sheets of an Excel (.xlsx) workbook as rows of cells.
type ExcelRead struct{}

func (ExcelRead) Spec() Spec {
	return Spec{Name: "excel_read", Description: "Read an .xlsx workbook: each sheet as a \"## name\" heading and one line per row, cells joined by \" | \". Formulas give their last value. Pass sheet to read one sheet.", Effect: EffectRead,
		Input: json.RawMessage(`{"type":"object","properties":{"path":{"type":"string","minLength":1},"sheet":{"type":"string"}},"required":["path"],"additionalProperties":false}`)}
}

func (ExcelRead) Run(ctx context.Context, call Call) (Result, error) {
	if err := ctx.Err(); err != nil {
		return Result{}, err
	}
	var input struct {
		Path  string `json:"path"`
		Sheet string `json:"sheet"`
	}
	if err := decodeInput(call.Input, &input); err != nil {
		return failure(err), nil
	}
	archive, err := openOffice(call.Env.Workdir, input.Path, ".xlsx")
	if err != nil {
		return failure(err), nil
	}
	defer archive.Close()
	text, err := workbookText(&archive.ReadCloser.Reader, input.Sheet)
	if err != nil {
		return failure(err), nil
	}
	return Result{Parts: []model.Part{{Text: text}}}, nil
}

type sheetRef struct{ name, target string }

func workbookText(archive *zip.Reader, only string) (string, error) {
	workbook, err := readEntry(archive, "xl/workbook.xml")
	if err != nil {
		return "", errors.New("this is not an Excel workbook")
	}
	var book struct {
		Sheets []struct {
			Name string `xml:"name,attr"`
			ID   string `xml:"id,attr"`
		} `xml:"sheets>sheet"`
	}
	if xml.Unmarshal(workbook, &book) != nil {
		return "", errors.New("the workbook could not be read")
	}
	targets := map[string]string{}
	if rels, err := readEntry(archive, "xl/_rels/workbook.xml.rels"); err == nil {
		var list struct {
			Items []struct {
				ID     string `xml:"Id,attr"`
				Target string `xml:"Target,attr"`
			} `xml:"Relationship"`
		}
		if xml.Unmarshal(rels, &list) == nil {
			for _, item := range list.Items {
				targets[item.ID] = item.Target
			}
		}
	}
	var sheets []sheetRef
	for i, sheet := range book.Sheets {
		target := targets[sheet.ID]
		if target == "" {
			target = "worksheets/sheet" + strconv.Itoa(i+1) + ".xml"
		}
		target = strings.TrimPrefix(target, "/")
		if !strings.HasPrefix(target, "xl/") {
			target = path.Join("xl", target)
		}
		sheets = append(sheets, sheetRef{sheet.Name, target})
	}
	shared := sharedStrings(archive)
	dates := dateStyles(archive)
	var out []string
	found := false
	for _, sheet := range sheets {
		if only != "" && sheet.name != only {
			continue
		}
		found = true
		body, err := readEntry(archive, sheet.target)
		if err != nil {
			return "", errors.New("the sheet " + sheet.name + " is missing from the workbook")
		}
		rows, err := sheetRows(body, shared, dates)
		if err != nil {
			return "", err
		}
		out = append(out, "## "+sheet.name)
		for _, row := range rows {
			out = append(out, strings.Join(row, " | "))
		}
	}
	if !found {
		return "", errors.New("the workbook has no sheet named " + only)
	}
	return strings.Join(out, "\n"), nil
}

func sharedStrings(archive *zip.Reader) []string {
	body, err := readEntry(archive, "xl/sharedStrings.xml")
	if err != nil {
		return nil
	}
	var table struct {
		Items []struct {
			Text []string `xml:"t"`
			Runs []struct {
				Text string `xml:"t"`
			} `xml:"r"`
		} `xml:"si"`
	}
	if xml.Unmarshal(body, &table) != nil {
		return nil
	}
	values := make([]string, len(table.Items))
	for i, item := range table.Items {
		values[i] = strings.Join(item.Text, "")
		for _, run := range item.Runs {
			values[i] += run.Text
		}
	}
	return values
}

// dateStyles finds the cell styles whose number format is a date, by the built-in format ids and the custom codes.
func dateStyles(archive *zip.Reader) map[int]bool {
	body, err := readEntry(archive, "xl/styles.xml")
	if err != nil {
		return nil
	}
	var styles struct {
		Formats []struct {
			ID   int    `xml:"numFmtId,attr"`
			Code string `xml:"formatCode,attr"`
		} `xml:"numFmts>numFmt"`
		Cells []struct {
			Format int `xml:"numFmtId,attr"`
		} `xml:"cellXfs>xf"`
	}
	if xml.Unmarshal(body, &styles) != nil {
		return nil
	}
	custom := map[int]string{}
	for _, format := range styles.Formats {
		custom[format.ID] = strings.ToLower(format.Code)
	}
	dates := map[int]bool{}
	for i, cell := range styles.Cells {
		switch {
		case cell.Format >= 14 && cell.Format <= 22, cell.Format >= 27 && cell.Format <= 36, cell.Format >= 45 && cell.Format <= 47, cell.Format >= 50 && cell.Format <= 58:
			dates[i] = true
		case custom[cell.Format] != "" && strings.ContainsAny(custom[cell.Format], "ymd") && !strings.Contains(custom[cell.Format], "["):
			dates[i] = true
		}
	}
	return dates
}

func columnIndex(reference string) int {
	index := 0
	for _, r := range reference {
		if r < 'A' || r > 'Z' {
			break
		}
		index = index*26 + int(r-'A') + 1
	}
	return index - 1
}

func sheetRows(body []byte, shared []string, dates map[int]bool) ([][]string, error) {
	decoder := xml.NewDecoder(bytes.NewReader(body))
	var rows [][]string
	var row []string
	for {
		token, err := decoder.Token()
		if err == io.EOF {
			break
		}
		if err != nil {
			return nil, errors.New("a sheet could not be read")
		}
		switch element := token.(type) {
		case xml.StartElement:
			switch element.Name.Local {
			case "row":
				row = nil
			case "c":
				var cell struct {
					Ref    string `xml:"r,attr"`
					Type   string `xml:"t,attr"`
					Style  int    `xml:"s,attr"`
					Value  string `xml:"v"`
					Inline struct {
						Text []string `xml:"t"`
						Runs []struct {
							Text string `xml:"t"`
						} `xml:"r"`
					} `xml:"is"`
				}
				if err := decoder.DecodeElement(&cell, &element); err != nil {
					return nil, errors.New("a sheet could not be read")
				}
				for len(row) < columnIndex(cell.Ref) {
					row = append(row, "")
				}
				inline := strings.Join(cell.Inline.Text, "")
				for _, run := range cell.Inline.Runs {
					inline += run.Text
				}
				row = append(row, cellValue(cell.Type, cell.Value, inline, cell.Style, shared, dates))
			}
		case xml.EndElement:
			if element.Name.Local == "row" {
				rows = append(rows, row)
			}
		}
	}
	return rows, nil
}

// cellValue turns the stored form of a cell into text: shared and inline strings, booleans, dates and numbers.
func cellValue(kind, value, inline string, style int, shared []string, dates map[int]bool) string {
	switch kind {
	case "s":
		if index, err := strconv.Atoi(strings.TrimSpace(value)); err == nil && index >= 0 && index < len(shared) {
			return shared[index]
		}
		return ""
	case "inlineStr":
		return inline
	case "b":
		if strings.TrimSpace(value) == "1" {
			return "true"
		}
		return "false"
	case "str", "e":
		return value
	}
	if dates[style] {
		if serial, err := strconv.ParseFloat(strings.TrimSpace(value), 64); err == nil {
			day := time.Date(1899, 12, 30, 0, 0, 0, 0, time.UTC).AddDate(0, 0, int(serial))
			return day.Format("2006-01-02")
		}
	}
	return strings.TrimSpace(value)
}

// ExcelWrite writes a new Excel workbook with one sheet.
type ExcelWrite struct{}

func (ExcelWrite) Spec() Spec {
	return Spec{Name: "excel_write", Description: "Write a one-sheet .xlsx workbook from rows (lists of text, number or boolean cells), replacing an existing file. Needs permission.", Effect: EffectWrite,
		Input: json.RawMessage(`{"type":"object","properties":{"path":{"type":"string","minLength":1},"sheet":{"type":"string","minLength":1,"maxLength":31},"rows":{"type":"array","items":{"type":"array","items":{"type":["string","number","boolean","null"]}}}},"required":["path","sheet","rows"],"additionalProperties":false}`)}
}

func (ExcelWrite) Run(ctx context.Context, call Call) (Result, error) {
	if err := ctx.Err(); err != nil {
		return Result{}, err
	}
	var input struct {
		Path  string  `json:"path"`
		Sheet string  `json:"sheet"`
		Rows  [][]any `json:"rows"`
	}
	if err := decodeInput(call.Input, &input); err != nil {
		return failure(err), nil
	}
	if input.Path == "" || !strings.EqualFold(filepath.Ext(input.Path), ".xlsx") {
		return failure(errors.New("the file must be a .xlsx file")), nil
	}
	if input.Sheet == "" || len([]rune(input.Sheet)) > 31 || strings.ContainsAny(input.Sheet, "[]:*?/\\") {
		return failure(errors.New("a sheet name has at most 31 characters and none of [ ] : * ? / \\")), nil
	}
	if len(input.Rows) > 1_000_000 {
		return failure(errors.New("too many rows")), nil
	}
	data, err := buildWorkbook(input.Sheet, input.Rows)
	if err != nil {
		return failure(err), nil
	}
	target := input.Path
	if !filepath.IsAbs(target) {
		target = filepath.Join(call.Env.Workdir, target)
	}
	if err := os.WriteFile(target, data, 0o600); err != nil {
		return failure(err), nil
	}
	return Result{Parts: []model.Part{{Text: fmt.Sprintf("Wrote %d rows to sheet %q of %s.", len(input.Rows), input.Sheet, input.Path)}}}, nil
}

func xmlText(text string) string {
	var buffer bytes.Buffer
	_ = xml.EscapeText(&buffer, []byte(text))
	return buffer.String()
}

func columnName(index int) string {
	name := ""
	for index++; index > 0; index = (index - 1) / 26 {
		name = string(rune('A'+(index-1)%26)) + name
	}
	return name
}

const (
	contentTypes  = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>`
	packageRels   = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`
	workbookRels  = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>`
	workbookStart = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="`
	workbookEnd   = `" sheetId="1" r:id="rId1"/></sheets></workbook>`
)

// buildWorkbook makes the smallest valid workbook: content types, relationships, a workbook and one sheet.
func buildWorkbook(sheet string, rows [][]any) ([]byte, error) {
	var data strings.Builder
	data.WriteString(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>`)
	for r, row := range rows {
		fmt.Fprintf(&data, `<row r="%d">`, r+1)
		for c, value := range row {
			ref := columnName(c) + strconv.Itoa(r+1)
			switch cell := value.(type) {
			case nil:
			case bool:
				flag := 0
				if cell {
					flag = 1
				}
				fmt.Fprintf(&data, `<c r="%s" t="b"><v>%d</v></c>`, ref, flag)
			case float64:
				fmt.Fprintf(&data, `<c r="%s"><v>%s</v></c>`, ref, strconv.FormatFloat(cell, 'f', -1, 64))
			case string:
				fmt.Fprintf(&data, `<c r="%s" t="inlineStr"><is><t xml:space="preserve">%s</t></is></c>`, ref, xmlText(cell))
			default:
				return nil, fmt.Errorf("row %d has a value of an unsupported kind", r+1)
			}
		}
		data.WriteString("</row>")
	}
	data.WriteString("</sheetData></worksheet>")
	files := []struct{ name, body string }{
		{"[Content_Types].xml", contentTypes},
		{"_rels/.rels", packageRels},
		{"xl/workbook.xml", workbookStart + xmlText(sheet) + workbookEnd},
		{"xl/_rels/workbook.xml.rels", workbookRels},
		{"xl/worksheets/sheet1.xml", data.String()},
	}
	var buffer bytes.Buffer
	archive := zip.NewWriter(&buffer)
	for _, file := range files {
		entry, err := archive.Create(file.name)
		if err != nil {
			return nil, err
		}
		if _, err := entry.Write([]byte(file.body)); err != nil {
			return nil, err
		}
	}
	if err := archive.Close(); err != nil {
		return nil, err
	}
	return buffer.Bytes(), nil
}
