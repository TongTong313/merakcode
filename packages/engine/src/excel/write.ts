import path from "path"
import { BlobWriter, TextReader, ZipWriter } from "@zip.js/zip.js"
import { Atomic } from "../file/atomic"

// Write-side data model, symmetric with the read side (ExcelCell/ExcelRow/ExcelSheet) for round trips
export type WriteCell = string | number | boolean | null

export type WriteSheet = {
  name: string
  rows: WriteCell[][]
}

export type WriteWorkbook = {
  sheets: WriteSheet[]
}

export type ExcelWriteOptions = {
  /** Maximum rows per sheet, a safety limit against runaway memory use. Default 1,000,000 */
  maxRowsPerSheet?: number
  /** Maximum cells per sheet. Default 50,000,000 */
  maxCellsPerSheet?: number
}

const DEFAULT_MAX_ROWS = 1_000_000
const DEFAULT_MAX_CELLS = 50_000_000
const MAX_SHEETS = 1000

const CONTENT_TYPE_SHEET = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"
const CONTENT_TYPE_WORKSHEET = "application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"
const CONTENT_TYPE_SHARED = "application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"
const CONTENT_TYPE_STYLES = "application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"

// Relationship types of the workbook relationship graph. Every part written to the package needs a relationship here,
// otherwise Excel/WPS drops it as an orphan; see workbookRelsXml.
const REL_TYPE_WORKSHEET = "http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet"
const REL_TYPE_SHARED_STRINGS = "http://schemas.openxmlformats.org/officeDocument/2006/relationships/sharedStrings"
const REL_TYPE_STYLES = "http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles"

/**
 * Writes workbook data to a new .xlsx file.
 *
 * - Only creates new workbooks; editing existing files in place is not supported, because keeping styles, formulas
 *   and merges would need a full round trip that costs far more than it is worth.
 * - Strings are deduplicated into sharedStrings (t="s"), matching the read side; output is smaller and reads back
 *   correctly.
 * - Number, boolean and string types are kept; empty cells (null/undefined) are skipped but stay aligned through
 *   r="A1" cell references.
 */
export async function writeExcelWorkbook(
  filePath: string,
  workbook: WriteWorkbook,
  options: ExcelWriteOptions = {},
): Promise<void> {
  const ext = path.extname(filePath).toLowerCase()
  if (ext !== ".xlsx" && ext !== ".xlsm") {
    throw new Error(`Unsupported Excel format: ${ext || "(none)"}. Supported formats: .xlsx and .xlsm.`)
  }

  const sheets = workbook.sheets
  if (!Array.isArray(sheets) || sheets.length === 0) {
    throw new Error("Workbook must contain at least one sheet.")
  }
  if (sheets.length > MAX_SHEETS) {
    throw new Error(`Too many sheets: ${sheets.length}. Limit: ${MAX_SHEETS}.`)
  }

  const maxRows = Math.max(1, options.maxRowsPerSheet ?? DEFAULT_MAX_ROWS)
  const maxCells = Math.max(1, options.maxCellsPerSheet ?? DEFAULT_MAX_CELLS)

  // Shared string table: string -> index
  const shared = new Map<string, number>()
  // Rendering each sheet also fills the shared table
  const sheetXmls = sheets.map((sheet, index) => renderSheet(sheet, index + 1, shared, maxRows, maxCells))
  const sharedXml = renderSharedStrings(shared)

  const writer = new ZipWriter(new BlobWriter(CONTENT_TYPE_SHEET))
  try {
    await add(writer, "[Content_Types].xml", contentTypesXml(sheets.length))
    await add(writer, "_rels/.rels", rootRelsXml())
    await add(writer, "xl/workbook.xml", workbookXml(sheets))
    await add(writer, "xl/_rels/workbook.xml.rels", workbookRelsXml(sheets.length))
    await add(writer, "xl/sharedStrings.xml", sharedXml)
    await add(writer, "xl/styles.xml", stylesXml())
    for (let index = 0; index < sheets.length; index++) {
      await add(writer, `xl/worksheets/sheet${index + 1}.xml`, sheetXmls[index])
    }
    const blob = await writer.close()
    // Same write path as the other file tools: with the sandbox available it writes the target directly so only one
    // file approval is triggered; otherwise it writes a temp file in the same directory and renames it.
    await Atomic.write(filePath, new Uint8Array(await blob.arrayBuffer()))
  } finally {
    await writer.close().catch(() => undefined)
  }
}

/** Renders one worksheet XML and registers its strings in the shared table */
function renderSheet(
  sheet: WriteSheet,
  sheetIndex: number,
  shared: Map<string, number>,
  maxRows: number,
  maxCells: number,
): string {
  if (!sheet.name || !sheet.name.trim()) {
    throw new Error(`Sheet at index ${sheetIndex - 1} has an empty name.`)
  }
  const rows = sheet.rows
  if (rows.length > maxRows) {
    throw new Error(`Sheet "${sheet.name}" has too many rows: ${rows.length}. Limit: ${maxRows}.`)
  }

  let cellCount = 0
  const rowXmls: string[] = []
  let maxCol = 0

  rows.forEach((row, rowIndex) => {
    const rowNum = rowIndex + 1
    const cellXmls: string[] = []
    row.forEach((cell, colIndex) => {
      if (cell === null || cell === undefined) return // skipped; r keeps the other cells aligned
      cellCount++
      const ref = cellRef(rowNum, colIndex + 1)
      if (colIndex + 1 > maxCol) maxCol = colIndex + 1
      cellXmls.push(renderCell(ref, cell, shared))
    })
    // Empty rows still get a <row> so row numbers stay contiguous, matching sparseRows on the read side
    rowXmls.push(`    <row r="${rowNum}">${cellXmls.join("")}</row>`)
  })

  if (cellCount > maxCells) {
    throw new Error(`Sheet "${sheet.name}" has too many cells: ${cellCount}. Limit: ${maxCells}.`)
  }

  const dimension = `A1:${maxCol > 0 ? cellRef(rows.length, maxCol) : "A1"}`
  return `<?xml version="1.0" encoding="UTF-8"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <dimension ref="${dimension}"/>
  <sheetData>
${rowXmls.join("\n")}
  </sheetData>
</worksheet>`
}

/** Renders one cell; strings are registered in the shared table and use t="s" */
function renderCell(ref: string, cell: Exclude<WriteCell, null | undefined>, shared: Map<string, number>): string {
  if (typeof cell === "number") {
    if (!Number.isFinite(cell)) return "" // skip non-finite numbers
    return `<c r="${ref}"><v>${cell}</v></c>`
  }
  if (typeof cell === "boolean") {
    return `<c r="${ref}" t="b"><v>${cell ? "1" : "0"}</v></c>`
  }
  const text = String(cell)
  let index = shared.get(text)
  if (index === undefined) {
    index = shared.size
    shared.set(text, index)
  }
  return `<c r="${ref}" t="s"><v>${index}</v></c>`
}

function renderSharedStrings(shared: Map<string, number>): string {
  const items = Array.from(shared.keys())
    .map((text) => `  <si><t>${encodeXml(text)}</t></si>`)
    .join("\n")
  return `<?xml version="1.0" encoding="UTF-8"?>
<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="${shared.size}" uniqueCount="${shared.size}">
${items}
</sst>`
}

function contentTypesXml(sheetCount: number): string {
  const overrides = Array.from(
    { length: sheetCount },
    (_, index) =>
      `  <Override PartName="/xl/worksheets/sheet${index + 1}.xml" ContentType="${CONTENT_TYPE_WORKSHEET}"/>`,
  ).join("\n")
  return `<?xml version="1.0" encoding="UTF-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/xl/workbook.xml" ContentType="${CONTENT_TYPE_SHEET}"/>
${overrides}
  <Override PartName="/xl/sharedStrings.xml" ContentType="${CONTENT_TYPE_SHARED}"/>
  <Override PartName="/xl/styles.xml" ContentType="${CONTENT_TYPE_STYLES}"/>
</Types>`
}

function rootRelsXml(): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>`
}

function workbookXml(sheets: WriteSheet[]): string {
  const sheetEntries = sheets
    .map((sheet, index) => `    <sheet name="${encodeXml(sheet.name)}" sheetId="${index + 1}" r:id="rId${index + 1}"/>`)
    .join("\n")
  return `<?xml version="1.0" encoding="UTF-8"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <sheets>
${sheetEntries}
  </sheets>
</workbook>`
}

function workbookRelsXml(sheetCount: number): string {
  const entries = Array.from(
    { length: sheetCount },
    (_, index) =>
      `  <Relationship Id="rId${index + 1}" Type="${REL_TYPE_WORKSHEET}" Target="worksheets/sheet${index + 1}.xml"/>`,
  )
  // The shared string table and the stylesheet must be registered here: Excel/WPS resolves parts through the OPC
  // relationship graph and drops parts without a relationship as orphans. String cells (t="s") reference the shared
  // string table, so without the relationship all text is blank in Excel while numbers (inlined in <v>) still show.
  // The read side reads xl/sharedStrings.xml and xl/styles.xml by fixed path, not through the graph, so excel_parse
  // round trips and openpyxl read everything; only real Excel exposes the defect.
  entries.push(
    `  <Relationship Id="rId${sheetCount + 1}" Type="${REL_TYPE_SHARED_STRINGS}" Target="sharedStrings.xml"/>`,
    `  <Relationship Id="rId${sheetCount + 2}" Type="${REL_TYPE_STYLES}" Target="styles.xml"/>`,
  )
  return `<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
${entries.join("\n")}
</Relationships>`
}

function stylesXml(): string {
  // Minimal stylesheet: a single default xf (numFmtId=0), no custom styles. Callers should pass dates as ISO strings,
  // matching the excelDate output of the read side.
  //
  // fonts/fills/borders must all be present: xf entries in cellXfs reference them by index, and Excel treats a
  // missing table as an incomplete styles part and asks to repair the file. The second fill, gray125, is a placeholder
  // Excel requires. Order follows the OOXML CT_Stylesheet sequence (fonts -> fills -> borders -> cellXfs).
  return `<?xml version="1.0" encoding="UTF-8"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <fonts count="1">
    <font><sz val="11"/><name val="Calibri"/></font>
  </fonts>
  <fills count="2">
    <fill><patternFill patternType="none"/></fill>
    <fill><patternFill patternType="gray125"/></fill>
  </fills>
  <borders count="1">
    <border><left/><right/><top/><bottom/><diagonal/></border>
  </borders>
  <cellXfs count="1">
    <xf numFmtId="0" fontId="0" fillId="0" borderId="0"/>
  </cellXfs>
</styleSheet>`
}

/** 1-based column number to Excel column letters, e.g. 1 -> A, 27 -> AA */
function columnLetters(col: number): string {
  let letters = ""
  let n = col
  while (n > 0) {
    const rem = (n - 1) % 26
    letters = String.fromCharCode(65 + rem) + letters
    n = Math.floor((n - 1) / 26)
  }
  return letters
}

/** 1-based row and column to a cell reference, e.g. (1,1) -> A1 */
function cellRef(row: number, col: number): string {
  return `${columnLetters(col)}${row}`
}

function encodeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;")
}

async function add(writer: ZipWriter<Blob>, name: string, text: string) {
  await writer.add(name, new TextReader(text))
}
