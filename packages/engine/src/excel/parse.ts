import fs from "fs/promises"
import path from "path"
import { BlobReader, ZipReader } from "@zip.js/zip.js"
import { runStream, StreamingSax } from "../util/sax"
import { attr, decodeXml, formatBytes, normalizeEntry, readEntry, tag, tags, type ZipEntry } from "../util/xml"
import { Filesystem } from "@merakcode/util/filesystem"

export type ExcelCell = string | number | boolean | null

export type ExcelRow = {
  number: number
  cells: ExcelCell[]
}

export type ExcelRowRange = {
  start: number
  end: number
}

export type ExcelSheet = {
  name: string
  dimension?: string
  totalRows: number
  totalCells: number
  truncated: boolean
  rows: ExcelRow[]
  /** Row range actually scanned in a ranged read (1-based, inclusive) */
  scannedRange?: ExcelRowRange
}

export type ExcelWorkbook = {
  filePath: string
  fileName: string
  format: "xlsx" | "xlsm"
  sheets: ExcelSheet[]
  truncated: boolean
  warnings: string[]
}

export type ExcelParseOptions = {
  sheets?: string[]
  maxSheets?: number
  maxRowsPerSheet?: number
  maxCellsPerSheet?: number
  /** Reads only rows in this range (1-based, inclusive), for reading large files in parts */
  rowRange?: ExcelRowRange
  /** Outputs only each sheet's dimension and first (header) row, for an overview of large files */
  summaryOnly?: boolean
  /** Maximum workbook file size in bytes, default 500MB */
  maxFileBytes?: number
  /** Maximum bytes scanned per part when streaming, a safety limit; default 1GB */
  maxScanBytes?: number
}

type Relationship = {
  id: string
  target: string
  type: string
}

type WorkbookSheet = {
  name: string
  path: string
}

type Cell = {
  ref: string
  type?: string
  style?: number
  value?: string
  inline?: string
}

// Streaming parsing does not hold the whole decompressed XML in memory, so the file size limit can be 500MB
const DEFAULT_MAX_WORKBOOK_BYTES = 500 * 1024 * 1024
// Stops malicious or malformed files from being scanned without end
const DEFAULT_MAX_SCAN_BYTES = 1024 * 1024 * 1024
const DEFAULT_MAX_SHEETS = 20
const MAX_SHEETS = 100
const DEFAULT_MAX_ROWS = 100
const MAX_MAX_ROWS = 1000
const DEFAULT_MAX_CELLS = 2000
const MAX_MAX_CELLS = 20000
const DATE_STYLE_IDS = new Set([14, 15, 16, 17, 22, 27, 30, 36, 45, 46, 47, 50, 57])
const WORKSHEET_RELATIONSHIP_TYPE = "http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet"

export async function parseExcelWorkbook(filePath: string, options: ExcelParseOptions = {}): Promise<ExcelWorkbook> {
  const ext = path.extname(filePath).toLowerCase()
  if (ext !== ".xlsx" && ext !== ".xlsm") {
    throw new Error(`Unsupported Excel format: ${ext || "(none)"}. Supported formats: .xlsx and .xlsm.`)
  }

  // The whole file is still read into memory at once for the zip central directory, but part decompression and XML
  // parsing are streamed, so the main memory peak (decompressed sheet XML) is never held in full.
  const stat = await fs.stat(filePath).catch(() => undefined)
  if (!stat) throw new Error(`File not found: ${filePath}`)
  if (stat.isDirectory()) throw new Error(`Expected an Excel file, got a directory: ${filePath}`)
  const maxFileBytes = options.maxFileBytes ?? DEFAULT_MAX_WORKBOOK_BYTES
  if (stat.size > maxFileBytes) {
    throw new Error(`Excel workbook is too large: ${formatBytes(stat.size)}. Limit: ${formatBytes(maxFileBytes)}.`)
  }

  const maxScanBytes = options.maxScanBytes ?? DEFAULT_MAX_SCAN_BYTES
  const range = normalizeRange(options.rowRange)

  const zip = new ZipReader(new BlobReader(new Blob([await Filesystem.readBytes(filePath)])))
  try {
    const entries = await zip.getEntries()
    const map = new Map(entries.map((entry) => [normalizeEntry(entry.filename), entry as ZipEntry]))
    const workbookEntry = map.get("xl/workbook.xml")
    if (!workbookEntry) throw new Error("Invalid Excel workbook: xl/workbook.xml not found")

    // Small parts are read as whole strings and parsed with regexes
    const workbookXml = await readEntry(workbookEntry)
    const rels = parseRelationships(await readEntry(map.get("xl/_rels/workbook.xml.rels")))
    const sheets = parseWorkbookSheets(workbookXml, rels)
    if (sheets.length === 0) throw new Error("Invalid Excel workbook: no worksheets found")

    // Streamed to avoid the double peak of building one large string and then running matchAll
    const shared = await parseSharedStringsStream(map.get("xl/sharedStrings.xml"), maxScanBytes)
    const dateStyles = parseDateStyles(await readEntry(map.get("xl/styles.xml")))
    const date1904 = parseDate1904(workbookXml)

    const selected = selectSheets(sheets, options.sheets)
    const maxSheets = Math.max(1, Math.min(options.maxSheets ?? DEFAULT_MAX_SHEETS, MAX_SHEETS))
    const limited = selected.slice(0, maxSheets)

    // A ranged read defaults the row limit to the range length (capped at 1000) so the range comes back at once
    const defaultMaxRows = range ? Math.max(1, range.end - range.start + 1) : DEFAULT_MAX_ROWS
    const maxRows = Math.max(1, Math.min(options.maxRowsPerSheet ?? defaultMaxRows, MAX_MAX_ROWS))
    const maxCells = Math.max(1, Math.min(options.maxCellsPerSheet ?? DEFAULT_MAX_CELLS, MAX_MAX_CELLS))

    const warnings: string[] = []
    const requested = options.sheets?.map((sheet) => sheet.trim()).filter(Boolean)
    if (requested?.length && selected.length === 0) {
      warnings.push(
        `No worksheets matched: ${requested.join(", ")}. Available sheets: ${sheets.map((sheet) => sheet.name).join(", ")}`,
      )
    }
    if (selected.length > limited.length) {
      warnings.push(
        `Only inspected first ${limited.length} of ${selected.length} selected worksheets. Use sheets or maxSheets to narrow or expand the selection.`,
      )
    }

    const parsed: ExcelSheet[] = []
    for (const sheet of limited) {
      const entry = map.get(sheet.path)
      if (!entry) {
        warnings.push(`Worksheet "${sheet.name}" is missing (${sheet.path})`)
        continue
      }
      parsed.push(
        await parseWorksheetStream(
          sheet.name,
          entry,
          shared,
          dateStyles,
          maxRows,
          maxCells,
          date1904,
          range,
          options.summaryOnly === true,
          maxScanBytes,
        ),
      )
    }

    return {
      filePath,
      fileName: path.basename(filePath),
      format: ext === ".xlsm" ? "xlsm" : "xlsx",
      sheets: parsed,
      truncated: parsed.some((sheet) => sheet.truncated),
      warnings,
    }
  } finally {
    await zip.close()
  }
}

export function formatExcelWorkbook(workbook: ExcelWorkbook): string {
  const lines = [
    `Excel: ${workbook.fileName} | Format: .${workbook.format} | Sheets: ${workbook.sheets.length}`,
    `Path: ${workbook.filePath}`,
    "",
  ]

  for (const sheet of workbook.sheets) {
    lines.push(`=== Sheet: ${sheet.name} ===`)
    lines.push(
      [
        `Rows shown: ${sheet.rows.length}`,
        `Non-empty rows scanned: ${sheet.totalRows}`,
        `Cells scanned: ${sheet.totalCells}`,
        sheet.dimension ? `Dimension: ${sheet.dimension}` : undefined,
        sheet.scannedRange ? `Range: ${sheet.scannedRange.start}-${sheet.scannedRange.end}` : undefined,
        sheet.truncated ? "Truncated: yes" : "Truncated: no",
      ]
        .filter(Boolean)
        .join(" | "),
    )

    if (sheet.rows.length === 0) {
      lines.push("(empty)")
      lines.push("")
      continue
    }

    const widths = columnWidths(sheet.rows.map((row) => row.cells))
    const rowLabelWidth = Math.max(3, ...sheet.rows.map((row) => String(row.number).length))
    for (const row of sheet.rows) {
      const cells = row.cells
        .map((cell, index) => pad(formatCell(cell), widths[index] ?? 0))
        .join(" | ")
        .trimEnd()
      lines.push(`Row ${String(row.number).padStart(rowLabelWidth, " ")} | ${cells}`.trimEnd())
    }
    lines.push("")
  }

  if (workbook.warnings.length > 0) {
    lines.push("=== Warnings ===")
    lines.push(...workbook.warnings)
    lines.push("")
  }

  if (workbook.truncated) {
    lines.push(
      "Some sheets were truncated. Re-run with fewer sheets, a higher row or cell limit, or a narrower row range.",
    )
  }

  return lines.join("\n").trimEnd()
}

function normalizeRange(range: ExcelRowRange | undefined): ExcelRowRange | undefined {
  if (!range) return undefined
  const start = Math.max(1, Math.floor(range.start))
  const end = Math.max(start, Math.floor(range.end))
  return { start, end }
}

/**
 * Worksheet event handler: accumulates cells from the `<row>` -> `<c>` -> `<v>/<is><t>` structure while streaming,
 * and aborts on the row limit, the range end or in summary mode to stop further decompression and parsing.
 */
class SheetHandler {
  dimension?: string
  rows: ExcelRow[] = []
  totalRows = 0
  totalCells = 0
  truncated = false

  private state: "outside" | "row" | "cell" | "value" | "inline" | "inlineText" = "outside"
  private curRowNum = 0
  private curCells: Cell[] = []
  private curCell: Cell | null = null
  private textTarget: "value" | "inline" | null = null
  private textBuf = ""

  constructor(
    private shared: string[],
    private dateStyles: Set<number>,
    private date1904: boolean,
    private maxRows: number,
    private maxCells: number,
    private range: ExcelRowRange | undefined,
    private summaryOnly: boolean,
    private onAbort: () => void,
  ) {}

  onOpenTag(name: string, attrs: Record<string, string>) {
    switch (name) {
      case "dimension":
        this.dimension = attrs.ref
        return
      case "row":
        this.state = "row"
        this.curRowNum = attrs.r ? Number(attrs.r) : this.totalRows + 1
        this.curCells = []
        return
      case "c":
        this.state = "cell"
        this.curCell = {
          ref: attrs.r ?? "",
          type: attrs.t,
          style: attrs.s !== undefined ? Number(attrs.s) : undefined,
        }
        return
      case "v":
        this.state = "value"
        this.textTarget = "value"
        this.textBuf = ""
        return
      case "is":
        this.state = "inline"
        return
      case "t":
        if (this.state === "inline") {
          this.state = "inlineText"
          this.textTarget = "inline"
          this.textBuf = ""
        }
        return
    }
  }

  onText(text: string) {
    if (this.textTarget) this.textBuf += text
  }

  onCloseTag(name: string) {
    switch (name) {
      case "v":
        if (this.curCell && this.textTarget === "value") this.curCell.value = this.textBuf
        this.textTarget = null
        this.state = "cell"
        return
      case "t":
        if (this.textTarget === "inline" && this.curCell) {
          this.curCell.inline = (this.curCell.inline ?? "") + this.textBuf
        }
        this.textTarget = null
        this.state = "inline"
        return
      case "is":
        this.state = "cell"
        return
      case "c":
        if (this.curCell) this.curCells.push(this.curCell)
        this.curCell = null
        this.state = "row"
        return
      case "row":
        this.state = "outside"
        this.finishRow()
        return
    }
  }

  private finishRow() {
    const cells = this.curCells
    this.curCells = []
    if (cells.length === 0) return
    const rowNum = this.curRowNum

    // Skip rows before the range and stop right after its end
    if (this.range) {
      if (rowNum < this.range.start) return
      if (rowNum > this.range.end) {
        this.truncated = true
        this.abort()
        return
      }
    }

    // Summary mode keeps only the first (header) row, then stops
    if (this.summaryOnly) {
      this.totalRows = 1
      this.totalCells = cells.length
      if (this.rows.length === 0) this.pushRow(rowNum, cells)
      this.truncated = true
      this.abort()
      return
    }

    this.totalRows++
    this.totalCells += cells.length
    // Over the row or cell limit: mark truncated and stop parsing further rows
    if (this.rows.length >= this.maxRows || this.totalCells > this.maxCells) {
      this.truncated = true
      this.abort()
      return
    }
    this.pushRow(rowNum, cells)
  }

  private pushRow(rowNum: number, cells: Cell[]) {
    const row: ExcelCell[] = []
    for (const cell of cells) {
      const column = columnIndex(cell.ref)
      row[column] = parseCellValue(cell, this.shared, this.dateStyles, this.date1904)
    }
    this.rows.push({ number: rowNum, cells: trimRow(row) })
  }

  private abort() {
    this.onAbort()
  }

  markTruncated() {
    this.truncated = true
  }

  toSheet(name: string): ExcelSheet {
    return {
      name,
      dimension: this.dimension,
      totalRows: this.totalRows,
      totalCells: this.totalCells,
      truncated: this.truncated,
      rows: this.rows,
      ...(this.range ? { scannedRange: { start: this.range.start, end: this.range.end } } : {}),
    }
  }
}

async function parseWorksheetStream(
  name: string,
  entry: ZipEntry,
  shared: string[],
  dateStyles: Set<number>,
  maxRows: number,
  maxCells: number,
  date1904: boolean,
  range: ExcelRowRange | undefined,
  summaryOnly: boolean,
  maxScanBytes: number,
): Promise<ExcelSheet> {
  const scanner = new StreamingSax()
  const handler = new SheetHandler(shared, dateStyles, date1904, maxRows, maxCells, range, summaryOnly, () =>
    scanner.abort(),
  )
  scanner.setHandler(handler)
  const status = await runStream(entry, scanner, maxScanBytes)
  // An aborted scan, for whatever reason, means the data was not read completely
  if (status === "aborted") handler.markTruncated()
  return handler.toSheet(name)
}

/** Streams `<si>` entries and joins their `<t>` texts, instead of building one large string and splitting by regex */
class SharedStringsHandler {
  strings: string[] = []
  private inSi = false
  private inT = false
  private buf = ""

  onOpenTag(name: string) {
    if (name === "si") {
      this.inSi = true
      this.buf = ""
    } else if (name === "t" && this.inSi) {
      this.inT = true
    }
  }

  onText(text: string) {
    if (this.inT) this.buf += text
  }

  onCloseTag(name: string) {
    if (name === "t") {
      this.inT = false
    } else if (name === "si") {
      this.strings.push(decodeXml(this.buf))
      this.inSi = false
    }
  }
}

async function parseSharedStringsStream(entry: ZipEntry | undefined, maxScanBytes: number): Promise<string[]> {
  if (!entry) return []
  const scanner = new StreamingSax()
  const handler = new SharedStringsHandler()
  scanner.setHandler(handler)
  await runStream(entry, scanner, maxScanBytes)
  return handler.strings
}

// Small parts (workbook, rels, styles) are parsed with regexes

function parseRelationships(xml: string): Relationship[] {
  return tags(xml, "Relationship").map((tag) => ({
    id: attr(tag.open, "Id") ?? "",
    target: attr(tag.open, "Target") ?? "",
    type: attr(tag.open, "Type") ?? "",
  }))
}

function parseWorkbookSheets(xml: string, rels: Relationship[]): WorkbookSheet[] {
  const byId = new Map(rels.filter((rel) => rel.type === WORKSHEET_RELATIONSHIP_TYPE).map((rel) => [rel.id, rel]))
  return tags(xml, "sheet")
    .map((tag) => {
      const name = attr(tag.open, "name")
      const rid = attr(tag.open, "r:id") ?? attr(tag.open, "id")
      if (!name || !rid) return undefined
      const target = byId.get(rid)?.target
      if (!target) return undefined
      return {
        name,
        path: resolveWorkbookTarget(target),
      }
    })
    .filter((sheet): sheet is WorkbookSheet => Boolean(sheet))
}

function resolveWorkbookTarget(target: string) {
  const normalized = normalizeEntry(target)
  if (normalized.startsWith("xl/")) return normalized
  return normalizeEntry(path.posix.join("xl", normalized))
}

function parseDateStyles(xml: string) {
  const result = new Set<number>()
  const customDateIds = new Set(
    tags(xml, "numFmt")
      .map((fmt) => {
        const id = Number(attr(fmt.open, "numFmtId"))
        const code = attr(fmt.open, "formatCode")
        return Number.isFinite(id) && code && isDateFormatCode(code) ? id : undefined
      })
      .filter((id): id is number => id !== undefined),
  )
  const cellXfs = tag(xml, "cellXfs")?.body ?? ""
  tags(cellXfs, "xf").forEach((xf, index) => {
    const id = Number(attr(xf.open, "numFmtId"))
    if (DATE_STYLE_IDS.has(id) || customDateIds.has(id)) result.add(index)
  })
  return result
}

function isDateFormatCode(format: string) {
  const cleaned = format
    .replace(/"([^"]|"")*"/g, "")
    .replace(/\\./g, "")
    .replace(/_.|\*./g, "")
    .replace(/\[[^\]]+\]/g, "")
    .replace(/AM\/PM/gi, "")
    .replace(/A\/P/gi, "")
  return /[ymdhs]/i.test(cleaned)
}

function parseDate1904(xml: string) {
  const value = attr(tag(xml, "workbookPr")?.open ?? "", "date1904")
  return value === "1" || value?.toLowerCase() === "true"
}

function selectSheets(sheets: WorkbookSheet[], selected: string[] | undefined) {
  const names = selected?.map((item) => item.trim()).filter(Boolean)
  if (!names?.length) return sheets
  const wanted = new Set(names.map((name) => name.toLowerCase()))
  return sheets.filter((sheet, index) => wanted.has(sheet.name.toLowerCase()) || wanted.has(String(index + 1)))
}

function parseCellValue(cell: Cell, shared: string[], dateStyles: Set<number>, date1904: boolean): ExcelCell {
  if (cell.type === "inlineStr") return decodeXml(cell.inline ?? "")
  if (cell.type === "s") return shared[Number(cell.value)] ?? ""
  if (cell.type === "str") return decodeXml(cell.value ?? "")
  if (cell.type === "b") return cell.value === "1"
  if (cell.type === "e") return cell.value ? `#${cell.value}` : null
  if (cell.value === undefined) return null

  const value = Number(cell.value)
  if (!Number.isFinite(value)) return decodeXml(cell.value)
  if (cell.style !== undefined && dateStyles.has(cell.style)) return excelDate(value, date1904)
  return value
}

function excelDate(serial: number, date1904: boolean) {
  const epoch = date1904 ? Date.UTC(1904, 0, 1) : Date.UTC(1899, 11, 30)
  const date = new Date(epoch + serial * 24 * 60 * 60 * 1000)
  if (!Number.isFinite(date.getTime())) return serial
  return date
    .toISOString()
    .replace("T", " ")
    .replace(/\.000Z$/, "Z")
}

function columnIndex(ref: string) {
  const letters = ref.match(/^[A-Z]+/i)?.[0]?.toUpperCase()
  if (!letters) return 0
  let index = 0
  for (const char of letters) index = index * 26 + char.charCodeAt(0) - 64
  return Math.max(0, index - 1)
}

function trimRow(row: ExcelCell[]) {
  let end = row.length
  while (end > 0 && (row[end - 1] === undefined || row[end - 1] === null || row[end - 1] === "")) end--
  return Array.from({ length: end }, (_, index) => row[index] ?? null)
}

function columnWidths(rows: ExcelCell[][]) {
  const widths: number[] = []
  for (const row of rows) {
    row.forEach((cell, index) => {
      widths[index] = Math.min(40, Math.max(widths[index] ?? 0, formatCell(cell).length))
    })
  }
  return widths
}

function formatCell(cell: ExcelCell) {
  if (cell === null) return ""
  if (typeof cell === "boolean") return cell ? "TRUE" : "FALSE"
  return String(cell).replace(/\s+/g, " ").slice(0, 200)
}

function pad(value: string, width: number) {
  return value + " ".repeat(Math.max(0, width - value.length))
}
