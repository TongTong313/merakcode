// Pure Word (.docx) parser.
//
// A .docx is a zip of OOXML parts: the body is in word/document.xml (<w:p> paragraphs, <w:t> text, <w:tbl> tables,
// <w:drawing> image references), image binaries in word/media/, and image relationships in
// word/_rels/document.xml.rels.
//
// Same structure as excel/parse.ts: document.xml is streamed through util/sax and aborted at the character or block
// range limit; small parts (rels) are read whole; images are extracted on demand for the vision channel.

import * as fs from "fs"
import * as os from "os"
import path from "path"
import { BlobReader, Uint8ArrayWriter, ZipReader } from "@zip.js/zip.js"
import { runStream, StreamingSax } from "../../../../infra/document/sax"
import { attr, normalizeEntry, readEntry, tags, type ZipEntry } from "../../../../infra/document/xml"
import { Filesystem } from "@merakcode/util/filesystem"

/** The body is a flat list of blocks in reading order */
export type DocxBlock = { kind: "paragraph"; text: string } | { kind: "table"; table: DocxTable }

export type DocxTable = {
  /**
   * Rows × columns; an empty string is a placeholder for a cell covered by a gridSpan/vMerge merge, so the shape
   * matches the rendered table
   */
  rows: string[][]
}

export type DocxImage = {
  /** File name under media/, e.g. image1.png */
  name: string
  /**
   * Absolute path of the image extracted to a temp directory; null if not extracted (vector formats such as
   * emf/wmf/svg that multimodal models cannot read)
   */
  path: string | null
  mime: string
}

export type DocxDocument = {
  filePath: string
  fileName: string
  blocks: DocxBlock[]
  tables: DocxTable[]
  images: DocxImage[]
  truncated: boolean
  warnings: string[]
}

export type DocxParseOptions = {
  /**
   * Block range (1-based, inclusive, e.g. "1:100"), like the excel rows paging; defaults to everything (bounded by
   * maxChars)
   */
  blockRange?: { start: number; end: number }
  extractImages?: boolean
  /** Total body character limit, default 6000, clamped to [500, 30000] (like pdf maxCharsPerPage) */
  maxChars?: number
  /** Byte limit for streaming one part, default 256MB (document.xml is usually far smaller) */
  maxScanBytes?: number
}

const DEFAULT_MAX_CHARS = 6000
const MIN_MAX_CHARS = 500
const MAX_MAX_CHARS = 30000
const DEFAULT_MAX_SCAN_BYTES = 256 * 1024 * 1024
/** Maximum number of extracted images, so a document with hundreds of images cannot flood the context */
const MAX_IMAGES = 20
/** Marks an image relationship Type */
const IMAGE_RELATIONSHIP_MARKER = "/image"

/**
 * document.xml event handler: walks the block-level children of <w:body> (paragraphs, tables), collecting paragraph
 * text (w:tab → \t, w:br/w:cr → \n) and image references (a:blip@r:embed). Cell text is collected recursively and
 * nested tables are flattened to text. Aborts when a limit is hit.
 */
class DocxBodyHandler {
  blocks: DocxBlock[] = []
  tables: DocxTable[] = []
  imageRefs: string[] = []
  truncated = false

  // Text of the current paragraph; paraOpen means we are inside a w:p
  private paraBuf = ""
  private paraOpen = false
  private inT = false

  // Table nesting depth; above 1 is a nested table whose tr/tc structure is ignored and only text kept
  private tblNesting = 0
  private table: TableState | null = null

  private blockIndex = 0
  private totalChars = 0

  constructor(
    private maxChars: number,
    private range: { start: number; end: number } | undefined,
    private rels: Map<string, string>,
    private onAbort: () => void,
  ) {}

  onOpenTag(name: string, attrs: Record<string, string>) {
    switch (name) {
      case "p":
        this.paraBuf = ""
        this.paraOpen = true
        return
      case "t":
        if (this.paraOpen) this.inT = true
        return
      case "tab":
        if (this.paraOpen) this.paraBuf += "\t"
        return
      case "br":
      case "cr":
        if (this.paraOpen) this.paraBuf += "\n"
        return
      case "blip":
        this.onBlip(attrs)
        return
      case "tbl":
        this.tblNesting++
        if (this.tblNesting === 1) this.table = new TableState()
        return
      case "tr":
        if (this.tblNesting === 1) this.table?.startRow()
        return
      case "tc":
        if (this.tblNesting === 1) this.table?.startCell()
        return
      case "gridSpan":
        if (this.tblNesting === 1 && this.table) this.table.gridSpan = Number(attrs.val ?? 1)
        return
      case "vMerge":
        // restart starts a merge; empty/continue is a placeholder covered by the cell above
        if (this.tblNesting === 1 && this.table) this.table.vMerge = attrs.val === "restart" ? "restart" : "continue"
        return
    }
  }

  onText(text: string) {
    if (this.inT) this.paraBuf += text
  }

  onCloseTag(name: string) {
    switch (name) {
      case "t":
        this.inT = false
        return
      case "p":
        this.flushParagraph()
        return
      case "tc":
        if (this.tblNesting === 1) this.table?.endCell()
        return
      case "tr":
        if (this.tblNesting === 1) this.table?.endRow()
        return
      case "tbl":
        if (this.tblNesting === 1 && this.table) {
          this.pushBlock({ kind: "table", table: this.table.toTable() })
          this.table = null
        }
        this.tblNesting = Math.max(0, this.tblNesting - 1)
        return
    }
  }

  /** Image reference: resolves rId to the media file name and writes [Image: xxx.png] at this point of the paragraph */
  private onBlip(attrs: Record<string, string>) {
    const rid = attrs["r:embed"] ?? attrs["embed"]
    if (!rid) return
    this.imageRefs.push(rid)
    if (this.paraOpen) this.paraBuf += `[Image: ${mediaBasename(resolveMediaRel(rid, this.rels))}]`
  }

  private flushParagraph() {
    if (!this.paraOpen) return
    this.paraOpen = false
    const text = this.paraBuf.trim()
    this.paraBuf = ""

    // A paragraph inside a table cell (including flattened nested tables) goes into the cell text
    if (this.tblNesting > 0 && this.table) {
      this.table.appendCellText(text)
      return
    }
    if (!text) return

    this.totalChars += text.length
    if (this.totalChars > this.maxChars) {
      this.truncated = true
      this.onAbort()
      return
    }
    this.pushBlock({ kind: "paragraph", text })
  }

  private pushBlock(block: DocxBlock) {
    this.blockIndex++
    // Skip blocks before the range and stop past its end
    if (this.range) {
      if (this.blockIndex < this.range.start) return
      if (this.blockIndex > this.range.end) {
        this.truncated = true
        this.onAbort()
        return
      }
    }
    this.blocks.push(block)
    if (block.kind === "table") this.tables.push(block.table)
  }

  markTruncated() {
    this.truncated = true
  }
}

/** Builds a top-level table from row/cell text, handling gridSpan (horizontal merge) and vMerge (vertical merge) */
class TableState {
  rows: string[][] = []
  gridSpan = 1
  vMerge: "none" | "restart" | "continue" = "none"

  private curRow: string[] = []
  private cellText = ""

  startRow() {
    this.curRow = []
  }

  startCell() {
    this.cellText = ""
    this.gridSpan = 1
    this.vMerge = "none"
  }

  /** Called when a paragraph in the cell is flushed (including text of flattened nested tables) */
  appendCellText(text: string) {
    if (!text) return
    this.cellText += (this.cellText ? "\n" : "") + text
  }

  endCell() {
    const cell = this.cellText.replace(/\s+/g, " ").trim()
    // Vertically merged continuation: an empty placeholder keeps the table shape
    if (this.vMerge === "continue") {
      this.curRow.push("")
      return
    }
    this.curRow.push(cell)
    // Horizontal merge: add span-1 empty placeholders
    for (let i = 1; i < this.gridSpan; i++) this.curRow.push("")
  }

  endRow() {
    if (this.curRow.length > 0) this.rows.push(this.curRow)
    this.curRow = []
  }

  toTable(): DocxTable {
    const colCount = Math.max(0, ...this.rows.map((row) => row.length))
    return {
      rows: this.rows.map((row) => {
        const normalized = [...row]
        while (normalized.length < colCount) normalized.push("")
        return normalized
      }),
    }
  }
}

export async function parseDocxDocument(filePath: string, options: DocxParseOptions = {}): Promise<DocxDocument> {
  const ext = path.extname(filePath).toLowerCase()
  if (ext !== ".docx") {
    throw new Error(`Unsupported Word format: ${ext || "(none)"}. Only .docx is supported.`)
  }

  const stat = await fs.promises.stat(filePath).catch(() => undefined)
  if (!stat) throw new Error(`File not found: ${filePath}`)
  if (stat.isDirectory()) throw new Error(`Expected a Word file, got a directory: ${filePath}`)

  const maxChars = Math.min(MAX_MAX_CHARS, Math.max(MIN_MAX_CHARS, options.maxChars ?? DEFAULT_MAX_CHARS))
  const maxScanBytes = options.maxScanBytes ?? DEFAULT_MAX_SCAN_BYTES
  const range = normalizeBlockRange(options.blockRange)

  const zip = new ZipReader(new BlobReader(new Blob([await Filesystem.readBytes(filePath)])))
  try {
    const entries = await zip.getEntries()
    const map = new Map(entries.map((entry) => [normalizeEntry(entry.filename), entry as ZipEntry]))

    const docEntry = map.get("word/document.xml")
    if (!docEntry) throw new Error("Invalid .docx: word/document.xml not found")

    // Image relationships, rId → media path (a small part, read whole)
    const rels = parseImageRelationships(await readEntry(map.get("word/_rels/document.xml.rels")))

    const scanner = new StreamingSax()
    const handler = new DocxBodyHandler(maxChars, range, rels, () => scanner.abort())
    scanner.setHandler(handler)
    const status = await runStream(docEntry, scanner, maxScanBytes)
    if (status === "aborted") handler.markTruncated()

    const images =
      options.extractImages === false ? [] : await extractImages(handler.imageRefs, rels, map, maxScanBytes)

    return {
      filePath,
      fileName: path.basename(filePath),
      blocks: handler.blocks,
      tables: handler.tables,
      images,
      truncated: handler.truncated,
      warnings: buildWarnings(images),
    }
  } finally {
    await zip.close()
  }
}

export function formatDocxDocument(doc: DocxDocument): string {
  const lines = [
    `Word: ${doc.fileName} | Blocks: ${doc.blocks.length} | Tables: ${doc.tables.length} | Images: ${doc.images.length}`,
    `Path: ${doc.filePath}`,
    "",
    "=== Text ===",
  ]

  for (const block of doc.blocks) {
    if (block.kind === "paragraph") {
      if (block.text) lines.push(block.text)
    } else {
      lines.push("")
      lines.push(tableToMarkdown(block.table))
      lines.push("")
    }
  }

  if (doc.images.length > 0) {
    lines.push("=== Images ===")
    lines.push(
      doc.images
        .map((img) => (img.path ? `[${img.name}] attached` : `[${img.name}] not extracted (vector format)`))
        .join("\n"),
    )
    lines.push("")
  }

  if (doc.warnings.length > 0) {
    lines.push("=== Warnings ===")
    lines.push(...doc.warnings)
    lines.push("")
  }

  if (doc.truncated) {
    lines.push("Document was truncated. Re-run with a narrower blocks range or larger maxChars.")
  }

  return lines.join("\n").trimEnd()
}

function tableToMarkdown(table: DocxTable): string {
  const rows = table.rows
  if (rows.length === 0) return "(empty table)"
  const header = rows[0]
  const lines = [
    "| " + header.map(escapeCell).join(" | ") + " |",
    "|" + header.map(() => "---").join("|") + "|",
    ...rows.slice(1).map((row) => "| " + row.map(escapeCell).join(" | ") + " |"),
  ]
  return lines.join("\n")
}

function escapeCell(value: string) {
  return value.replace(/\|/g, "\\|").replace(/\n/g, " ")
}

/** Parses document.xml.rels into image relationships: rId → Target (media path relative to word/) */
function parseImageRelationships(xml: string): Map<string, string> {
  const map = new Map<string, string>()
  if (!xml) return map
  for (const rel of tags(xml, "Relationship")) {
    const id = attr(rel.open, "Id")
    const type = attr(rel.open, "Type")
    const target = attr(rel.open, "Target")
    if (id && target && type?.includes(IMAGE_RELATIONSHIP_MARKER)) map.set(id, target)
  }
  return map
}

/** Resolves rId to a media path relative to word/ (e.g. "media/image1.png"); returns the rId if unknown */
function resolveMediaRel(rid: string, rels: Map<string, string>): string {
  const target = rels.get(rid)
  if (!target) return rid
  return normalizeEntry(target)
    .replace(/^word\//, "")
    .replace(/^(\.\.\/)+/, "")
}

/** Basename of a media path, split on / so it is the same on every platform */
function mediaBasename(rel: string): string {
  const idx = rel.lastIndexOf("/")
  return idx === -1 ? rel : rel.slice(idx + 1)
}

/** Mime of raster images multimodal models can read; null for vector formats such as emf/wmf/svg (not extracted) */
function mimeForName(name: string): string | null {
  const ext = path.extname(name).toLowerCase()
  switch (ext) {
    case ".png":
      return "image/png"
    case ".jpg":
    case ".jpeg":
      return "image/jpeg"
    case ".gif":
      return "image/gif"
    case ".bmp":
      return "image/bmp"
    default:
      return null
  }
}

/** Extracts media images to a temp directory: deduplicated, capped, vector formats skipped */
async function extractImages(
  imageRefs: string[],
  rels: Map<string, string>,
  entries: Map<string, ZipEntry>,
  maxScanBytes: number,
): Promise<DocxImage[]> {
  const images: DocxImage[] = []
  const seen = new Set<string>()
  for (const rid of imageRefs) {
    if (seen.has(rid)) continue
    seen.add(rid)

    const rel = resolveMediaRel(rid, rels)
    const name = mediaBasename(rel)
    const mime = mimeForName(name)
    // Unsupported formats such as vector images: not extracted, but listed
    if (!mime) {
      images.push({ name, path: null, mime: "application/octet-stream" })
      continue
    }

    const entry = entries.get(normalizeEntry(`word/${rel}`))
    if (!entry) {
      images.push({ name, path: null, mime })
      continue
    }
    // Skip images larger than the scan limit
    if (typeof entry.uncompressedSize === "number" && entry.uncompressedSize > maxScanBytes) continue

    try {
      const data = (await entry.getData(new Uint8ArrayWriter())) as Uint8Array
      const dir = path.join(os.tmpdir(), "merakcode-docx")
      fs.mkdirSync(dir, { recursive: true })
      const tmpPath = path.join(dir, `${Date.now()}-${name}`)
      await Filesystem.write(tmpPath, data)
      images.push({ name, path: tmpPath, mime })
    } catch {
      images.push({ name, path: null, mime })
    }

    if (images.length >= MAX_IMAGES) break
  }
  return images
}

function normalizeBlockRange(range: DocxParseOptions["blockRange"]): { start: number; end: number } | undefined {
  if (!range) return undefined
  const start = Math.max(1, Math.floor(range.start))
  const end = Math.max(start, Math.floor(range.end))
  return { start, end }
}

function buildWarnings(images: DocxImage[]): string[] {
  const warnings: string[] = []
  const vectorImages = images.filter((img) => img.path === null && img.mime === "application/octet-stream")
  if (vectorImages.length > 0) {
    warnings.push(
      `Skipped ${vectorImages.length} vector image(s) (emf/wmf/svg): ${vectorImages.map((img) => img.name).join(", ")}. Only raster formats (png/jpeg/gif/bmp) are extracted.`,
    )
  }
  return warnings
}
