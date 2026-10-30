export const EXCEL_SKILL = {
  name: "excel",
  description:
    "Read and write Excel spreadsheet files (.xlsx and .xlsm). Use when analyzing workbooks, worksheets, tables, rows, columns, formula cached values, sheet summaries, schema discovery, data extraction, or exporting data to a new Excel workbook.",
  content: `# excel

Use the built-in \`excel_parse\` / \`excel_write\` tools to read and write spreadsheet data. Do NOT shell out to any external script — the built-in tools ship inside the binary and work in installed packages.

\`excel_parse\` / \`excel_write\` are deferred tools - they are NOT in your tool list by default. If you don't see them, call \`tool_search("excel_parse")\` (or \`tool_search("excel_write")\`) first to activate; they become available with full parameters in your NEXT turn. If activation still fails, ask the user - do NOT fall back to shell scripts or external libraries.

## Read a workbook

Call \`excel_parse\` with the workbook path:

\`\`\`
excel_parse(filePath: "<workbook.xlsx>")
\`\`\`

By default it inspects at most 20 sheets, 100 rows per sheet, 2000 cells per sheet. The output is formatted text showing headers, data rows, cell types, totals, empty columns, and original Excel row numbers.

To get the parsed workbook as JSON for structured follow-up work, pass \`json: true\`:

\`\`\`
excel_parse(filePath: "<workbook.xlsx>", json: true)
\`\`\`

Inspect one worksheet (by name or 1-based index), with limits:

\`\`\`
excel_parse(filePath: "<workbook.xlsx>", sheets: ["Sheet1"], maxRows: 50, maxCells: 1000)
\`\`\`

## Reading large files in chunks

\`excel_parse\` streams worksheet XML and stops early once limits are hit, so cost scales with the rows you actually read. For very large sheets, page through them by row range instead of loading everything at once:

1. First get an overview with \`summary: true\` (dimension + header per sheet):

\`\`\`
excel_parse(filePath: "<big.xlsx>", summary: true)
\`\`\`

2. Then drill into a specific row range with \`rows\` (1-based, closed, e.g. \`"1001:2000"\`):

\`\`\`
excel_parse(filePath: "<big.xlsx>", sheets: ["Sheet1"], rows: "1001:2000")
\`\`\`

3. Increment the \`"start:end"\` range to page forward. Stop when fewer rows than the range length come back.

## Writing / exporting Excel

To export data to a **new** .xlsx workbook, call \`excel_write\` with an output path and a \`sheets\` array. The shape mirrors the \`excel_parse\` JSON data model, so you can read a workbook, transform it in memory, and write a new one back out.

\`\`\`
excel_write(
  output: "<out.xlsx>",
  sheets: [
    { name: "Sheet1", rows: [["Name", "Amount", "Active"], ["Alice", 42, true], ["Bob", null, false]] }
  ]
)
\`\`\`

- Each cell can be string | number | boolean | null. Null cells are skipped in the output, and column alignment is kept through cell references (e.g. A1).
- Strings are deduplicated through the shared strings table and number/boolean types are preserved, so the written file reads back correctly with \`excel_parse\`.

## Updating an existing workbook

\`excel_write\` creates a new workbook only — it does **not** edit an existing file in place. In-place edits would silently lose styles, formulas, merged cells, charts, and column widths, because \`excel_parse\` captures values/cached values only, not formatting. To update an existing workbook, use the **read → transform → write** pattern: read it as JSON, modify the data in memory, then write a new file back out (overwrite the original if desired).

1. Read the source workbook as JSON:

\`\`\`
excel_parse(filePath: "<source.xlsx>", json: true)
\`\`\`

2. Edit the JSON in memory: change cell values, add/remove rows or sheets, rename sheets, etc. The JSON shape matches the writer input (\`{ sheets: [{ name, rows }] }\`), but note the read-side adds \`number\`, \`dimension\`, \`totalRows\` etc. — strip those and keep only \`name\` + \`rows\` for writing.

3. Write the updated workbook:

\`\`\`
excel_write(output: "<updated.xlsx>", sheets: [...])
\`\`\`

Notes:
- This is a **data-level** rewrite: original styles/formulas/formatting are not preserved. If preserving formatting is required, ask the user to apply changes in Excel itself.

## excel_parse parameters

- \`sheets\`: array of worksheet names or 1-based indexes to inspect.
- \`maxSheets\`: maximum number of worksheets to inspect. Default 20.
- \`maxRows\`: maximum rows shown per sheet. Default 100.
- \`maxCells\`: maximum cells scanned per sheet. Default 2000.
- \`rows\`: read only the rows in a 1-based closed range, such as \`"1001:2000"\`. Use it to page through large files.
- \`summary\`: output only each sheet's dimension and header row.
- \`json\`: output the parsed workbook as JSON, for structured follow-up analysis.

## excel_write parameters

- \`output\`: output .xlsx or .xlsm path. Required.
- \`sheets\`: \`[{ name, rows: [[cell, ...], ...] }]\`; each cell can be string | number | boolean | null.
- \`maxRows\`: maximum rows per sheet. Default 1000000.
- \`maxCells\`: maximum cells per sheet. Default 50000000.

## Notes

- Supports \`.xlsx\` and \`.xlsm\` workbooks.
- Legacy binary \`.xls\` is not supported by the built-in parser; if needed, ask the user for an \`.xlsx\` export.
- Parsing returns values and cached formula values, not formula expressions or formatting details; common built-in and custom Excel date formats are decoded.
- Do not use \`read\` directly on Excel files; use \`excel_parse\` so the workbook is decoded correctly instead of being rejected as binary.
`,
}
