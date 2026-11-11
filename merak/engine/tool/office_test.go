package tool_test

import (
	"archive/zip"
	"bytes"
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/TongTong313/merakcode/merak/engine/tool"
)

// zipFile writes a zip archive with the given entries.
func zipFile(t *testing.T, path string, entries map[string]string) {
	t.Helper()
	var buffer bytes.Buffer
	archive := zip.NewWriter(&buffer)
	for name, body := range entries {
		file, err := archive.Create(name)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := file.Write([]byte(body)); err != nil {
			t.Fatal(err)
		}
	}
	if err := archive.Close(); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, buffer.Bytes(), 0o600); err != nil {
		t.Fatal(err)
	}
}

func text(result tool.Result) string {
	var all strings.Builder
	for _, part := range result.Parts {
		all.WriteString(part.Text)
	}
	return all.String()
}

func TestDocxReadReturnsHeadingsParagraphsAndTablesInOrder(t *testing.T) {
	dir := t.TempDir()
	const document = `<?xml version="1.0" encoding="UTF-8"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>
<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>Quarterly report</w:t></w:r></w:p>
<w:p><w:r><w:t xml:space="preserve">Revenue grew </w:t></w:r><w:r><w:t>12%.</w:t></w:r></w:p>
<w:p><w:pPr><w:pStyle w:val="Heading2"/></w:pPr><w:r><w:t>Numbers</w:t></w:r></w:p>
<w:tbl>
<w:tr><w:tc><w:p><w:r><w:t>Region</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>Sales</w:t></w:r></w:p></w:tc></w:tr>
<w:tr><w:tc><w:p><w:r><w:t>North</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>40</w:t></w:r></w:p></w:tc></w:tr>
</w:tbl>
<w:p><w:r><w:t>Line one</w:t></w:r><w:r><w:br/></w:r><w:r><w:t>Line two</w:t></w:r></w:p>
</w:body></w:document>`
	zipFile(t, filepath.Join(dir, "report.docx"), map[string]string{"word/document.xml": document, "[Content_Types].xml": "<Types/>"})
	result, err := (tool.DocxRead{}).Run(context.Background(), tool.Call{Input: json.RawMessage(`{"path":"report.docx"}`), Env: tool.Env{Workdir: dir}})
	if err != nil || result.IsError {
		t.Fatalf("result=%+v err=%v", result, err)
	}
	got := text(result)
	order := []string{"# Quarterly report", "Revenue grew 12%.", "## Numbers", "Region | Sales", "North | 40", "Line one\nLine two"}
	last := -1
	for _, want := range order {
		at := strings.Index(got, want)
		if at <= last {
			t.Fatalf("%q is missing or out of order in:\n%s", want, got)
		}
		last = at
	}
	for _, bad := range []string{`{"path":"missing.docx"}`, `{"path":"report.txt"}`} {
		if r, _ := (tool.DocxRead{}).Run(context.Background(), tool.Call{Input: json.RawMessage(bad), Env: tool.Env{Workdir: dir}}); !r.IsError {
			t.Errorf("%s was accepted", bad)
		}
	}
	if err := os.WriteFile(filepath.Join(dir, "broken.docx"), []byte("not a zip"), 0o600); err != nil {
		t.Fatal(err)
	}
	if r, _ := (tool.DocxRead{}).Run(context.Background(), tool.Call{Input: json.RawMessage(`{"path":"broken.docx"}`), Env: tool.Env{Workdir: dir}}); !r.IsError {
		t.Error("a file that is not a Word document was read")
	}
}

func TestExcelReadHandlesSharedStringsNumbersBooleansAndDates(t *testing.T) {
	dir := t.TempDir()
	zipFile(t, filepath.Join(dir, "book.xlsx"), map[string]string{
		"xl/workbook.xml":            `<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Sales" sheetId="1" r:id="rId1"/><sheet name="Notes" sheetId="2" r:id="rId2"/></sheets></workbook>`,
		"xl/_rels/workbook.xml.rels": `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Target="worksheets/sheet2.xml"/></Relationships>`,
		"xl/sharedStrings.xml":       `<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><si><t>Region</t></si><si><t>Total</t></si><si><r><t>No</t></r><r><t>rth</t></r></si></sst>`,
		"xl/styles.xml":              `<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><cellXfs count="2"><xf numFmtId="0"/><xf numFmtId="14"/></cellXfs></styleSheet>`,
		"xl/worksheets/sheet1.xml": `<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>
<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c><c r="C1" t="inlineStr"><is><t>Flag</t></is></c></row>
<row r="2"><c r="A2" t="s"><v>2</v></c><c r="B2"><v>40.5</v></c><c r="C2" t="b"><v>1</v></c><c r="D2" s="1"><v>45292</v></c></row>
<row r="4"><c r="A4"><f>SUM(B2:B3)</f><v>40.5</v></c></row>
</sheetData></worksheet>`,
		"xl/worksheets/sheet2.xml": `<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="1"><c r="A1" t="str"><v>hello</v></c></row></sheetData></worksheet>`,
	})
	read := func(input string) (tool.Result, string) {
		result, err := (tool.ExcelRead{}).Run(context.Background(), tool.Call{Input: json.RawMessage(input), Env: tool.Env{Workdir: dir}})
		if err != nil {
			t.Fatal(err)
		}
		return result, text(result)
	}
	result, all := read(`{"path":"book.xlsx"}`)
	if result.IsError {
		t.Fatalf("result=%+v", result)
	}
	for _, want := range []string{"## Sales", "Region | Total | Flag", "North | 40.5 | true | 2024-01-01", "40.5", "## Notes", "hello"} {
		if !strings.Contains(all, want) {
			t.Errorf("the output lacks %q:\n%s", want, all)
		}
	}
	if _, onlyNotes := read(`{"path":"book.xlsx","sheet":"Notes"}`); strings.Contains(onlyNotes, "Region") || !strings.Contains(onlyNotes, "hello") {
		t.Errorf("one sheet was asked for: %s", onlyNotes)
	}
	if r, _ := read(`{"path":"book.xlsx","sheet":"Nowhere"}`); !r.IsError {
		t.Error("a sheet that does not exist was read")
	}
}

func TestExcelWriteMakesAWorkbookThatExcelReadReadsBackUnchanged(t *testing.T) {
	dir := t.TempDir()
	rows := [][]any{
		{"Name", "Qty", "Done", "Note"},
		{"Widget", 3, true, "has <angle> & \"quotes\""},
		{"Gadget", 2.5, false, ""},
		{"Late", 1, true, "ünïcode and 中文"},
	}
	input, _ := json.Marshal(map[string]any{"path": "out.xlsx", "sheet": "Stock", "rows": rows})
	call := tool.Call{Input: input, Env: tool.Env{Workdir: dir}}
	result, err := (tool.ExcelWrite{}).Run(context.Background(), call)
	if err != nil || result.IsError {
		t.Fatalf("result=%+v err=%v", result, err)
	}
	archive, err := zip.OpenReader(filepath.Join(dir, "out.xlsx"))
	if err != nil {
		t.Fatalf("the output is not a zip: %v", err)
	}
	have := map[string]bool{}
	for _, entry := range archive.File {
		have[entry.Name] = true
	}
	archive.Close()
	for _, name := range []string{"[Content_Types].xml", "_rels/.rels", "xl/workbook.xml", "xl/_rels/workbook.xml.rels", "xl/worksheets/sheet1.xml"} {
		if !have[name] {
			t.Errorf("the package lacks %s (has %v)", name, have)
		}
	}
	read, err := (tool.ExcelRead{}).Run(context.Background(), tool.Call{Input: json.RawMessage(`{"path":"out.xlsx"}`), Env: tool.Env{Workdir: dir}})
	if err != nil || read.IsError {
		t.Fatalf("read=%+v err=%v", read, err)
	}
	got := text(read)
	for _, want := range []string{"## Stock", "Name | Qty | Done | Note", `Widget | 3 | true | has <angle> & "quotes"`, "Gadget | 2.5 | false |", "Late | 1 | true | ünïcode and 中文"} {
		if !strings.Contains(got, want) {
			t.Errorf("reading it back lacks %q:\n%s", want, got)
		}
	}
	if r, _ := (tool.ExcelWrite{}).Run(context.Background(), tool.Call{Input: json.RawMessage(`{"path":"bad.txt","sheet":"S","rows":[["a"]]}`), Env: tool.Env{Workdir: dir}}); !r.IsError {
		t.Error("a file that is not .xlsx was written")
	}
	if r, _ := (tool.ExcelWrite{}).Run(context.Background(), tool.Call{Input: json.RawMessage(`{"path":"x.xlsx","sheet":"A/B","rows":[["a"]]}`), Env: tool.Env{Workdir: dir}}); !r.IsError {
		t.Error("a sheet name Excel refuses was accepted")
	}
	if (tool.ExcelWrite{}).Spec().Effect != tool.EffectWrite || (tool.ExcelRead{}).Spec().Effect != tool.EffectRead || (tool.DocxRead{}).Spec().Effect != tool.EffectRead {
		t.Error("effects: reading is a read, writing a workbook is a write")
	}
}
