import z from "zod"
import * as fs from "fs"
import * as path from "path"
import * as os from "os"
import { pathToFileURL } from "url"
import { Tool } from "./tool"
import DESCRIPTION from "./pdf-parse.txt"
import { Instance } from "../project/instance"
import { Workspace } from "../project/workspace"
import { Identifier } from "@merakcode/util/id"
import { loadSystemFonts, prepareCanvasForPdfjs } from "../util/canvas-native"
import { loadPdfjsRuntime } from "../util/pdfjs-runtime"
import { PermissionPolicy } from "../permission/policy"

/** Thrown by renderPagesToImages when canvas is unavailable; execute catches it and falls back to a split-page PDF. */
class CanvasUnavailableError extends Error {
  constructor(public reason: string) {
    super(reason)
    this.name = "CanvasUnavailableError"
  }
}

/**
 * Built-in PDF parsing tool. pdfjs-dist and pdf-lib ship with the engine, so nothing is installed at runtime.
 *
 * - Parsing lives in the pure function `parsePdf`, shared by ReadTool and this tool. ReadTool relies on its own
 *   read/external_directory permission; when the model calls this tool, execute asks for permission and the
 *   framework truncates the output.
 * - Each page is classified as text/image/mixed/table/empty using pdfjs getOperatorList heuristics.
 * - image/mixed/table pages are split into a separate PDF with qpdf, or pdf-lib as a fallback, for multimodal reading.
 */

type Mode = "auto" | "text" | "vision"
type PageType = "text" | "image" | "mixed" | "table" | "empty"

type PageResult = {
  pageNum: number
  type: PageType
  text: string
}

type PdfAnalysis = {
  output: string
  totalPages: number
  pageNums: number[]
  visionPages: number[]
  // Split-page PDF of the vision pages (auto/vision mode). When canvas is unavailable, execute points the model to
  // it instead of rendered images.
  visionPath: string | null
}

type TextItem = {
  str?: string
  transform?: readonly number[]
}

/**
 * Parses a PDF without a tool context: no permission prompt and no truncation. Shared by ReadTool and
 * PdfParseTool.execute.
 *
 * @param filePath absolute path of the PDF
 * @param opts.pages page range, default "1-10", at most 20 pages per call
 * @param opts.mode "auto" | "text" | "vision", default "auto"
 * @param opts.maxCharsPerPage text limit per page, default 6000, clamped to [500, 30000]
 * @returns the formatted parse result
 */
export async function parsePdf(
  filePath: string,
  opts: {
    pages?: string
    mode?: Mode
    maxCharsPerPage?: number
  } = {},
): Promise<string> {
  return (await analyzePdf(filePath, opts)).output
}

async function analyzePdf(
  filePath: string,
  opts: {
    pages?: string
    mode?: Mode
    maxCharsPerPage?: number
    onProgress?: (msg: string) => void
  } = {},
): Promise<PdfAnalysis> {
  if (!fs.existsSync(filePath)) throw new Error(`File not found: ${filePath}`)

  const mode: Mode = opts.mode || "auto"
  const maxChars = Math.min(30000, Math.max(500, opts.maxCharsPerPage || 6000))

  // pdfjs is loaded lazily. Its pdf.mjs requires @napi-rs/canvas at module top level to install the
  // DOMMatrix/ImageData/Path2D polyfills, once and without retry; if canvas is missing then, rendering later fails
  // with a ReferenceError on ImageData. So prepareCanvasForPdfjs must run before pdfjs is imported. Text extraction
  // does not need canvas, so a failure here is ignored. Progress goes to onProgress, which execute appends to the
  // tool output.
  const preparedCanvas = await prepareCanvasForPdfjs(opts.onProgress).catch(() => null)
  const {
    pdfjs: pdfjsLib,
    task,
    doc,
  } = await open(filePath, preparedCanvas?.ok ? createPdfCanvasFactory(preparedCanvas.canvas) : undefined)

  try {
    const totalPages = doc.numPages

    const pageRange = opts.pages || "1-10"
    const pageNums = parsePageRange(pageRange, totalPages)
    if (pageNums.length > 20) throw new Error(`Max 20 pages per call (requested ${pageNums.length})`)

    // vision mode skips the per-page analysis and splits every requested page.
    if (mode === "vision") {
      const outPath = await splitPages(filePath, pageNums)
      return {
        output: formatVisionOnly(filePath, totalPages, pageNums, outPath),
        totalPages,
        pageNums,
        visionPages: pageNums,
        visionPath: outPath,
      }
    }

    const results: PageResult[] = []
    for (const num of pageNums) {
      const page = await doc.getPage(num)
      const textContent = await page.getTextContent()
      const text = layoutText(textContent.items)

      let hasImages = false
      let hasTableHint = false

      if (mode === "auto") {
        const ops = await page.getOperatorList()
        const fnArray = ops.fnArray

        hasImages = fnArray.some((fn: number) => isImageOp(pdfjsLib.OPS, fn))

        const pathCount = fnArray.filter(
          (fn: number) =>
            fn === pdfjsLib.OPS.constructPath ||
            fn === pdfjsLib.OPS.stroke ||
            fn === pdfjsLib.OPS.fill ||
            fn === pdfjsLib.OPS.eoFill,
        ).length
        hasTableHint = pathCount > 20
      }

      const type = classifyPage(text, hasImages, hasTableHint, mode)
      results.push({ pageNum: num, type, text })
    }

    const visionPages = results.filter((p) => ["image", "mixed", "table"].includes(p.type))
    let visionPath: string | null = null
    if (visionPages.length > 0 && mode === "auto") {
      visionPath = await splitPages(
        filePath,
        visionPages.map((p) => p.pageNum),
      )
    }

    return {
      output: formatOutput(filePath, totalPages, results, visionPath, mode, maxChars),
      totalPages,
      pageNums,
      visionPages: visionPages.map((p) => p.pageNum),
      visionPath,
    }
  } finally {
    await task.destroy()
  }
}

export const PdfParseTool = Tool.define(
  "pdf_parse",
  {
    description: DESCRIPTION,
    parameters: z.object({
      filePath: z
        .string()
        .describe("Absolute path to the PDF file (relative paths resolve against the project directory)"),
      pages: z.string().optional().describe("Page range: '1-10', '5,8-12'. Default '1-10'. Max 20/call."),
      mode: z
        .enum(["auto", "text", "vision"])
        .optional()
        .describe("'auto': per-page smart routing. 'text': text only. 'vision': split all for visual. Default 'auto'"),
      maxCharsPerPage: z
        .number()
        .min(500)
        .max(30000)
        .optional()
        .describe("Max chars per page in output. Default 6000."),
    }),
    async execute(params, ctx) {
      // Relative paths resolve against the primary folder; absolute paths may be in any workspace folder, as in read.
      const filePath = Workspace.resolveToolPath(Instance.workspace, params.filePath).filepath
      if (!fs.existsSync(filePath)) throw new Error(`File not found: ${filePath}`)

      // Access outside the workspace is blocked by the sandbox via workDirs, so only read permission is asked here.
      // ReadTool calls parsePdf directly and never reaches this prompt.
      await ctx.ask({
        permission: "read",
        checks: [PermissionPolicy.file({ op: "read", path: filePath, ...PermissionPolicy.scope() })],
        metadata: { filepath: filePath },
      })

      // Canvas download progress, only produced on the first download. It is appended to the tool output because
      // console.log would land in the input box, and pdf_parse renders as GenericTool, which shows no running
      // metadata.
      const canvasProgressNotes: string[] = []
      const onProgress = (msg: string) => {
        canvasProgressNotes.push(msg)
      }

      const analysis = await analyzePdf(filePath, {
        pages: params.pages,
        mode: params.mode,
        maxCharsPerPage: params.maxCharsPerPage,
        onProgress,
      })

      // Render vision pages to PNG. Without canvas, fall back to the split-page PDF that analyzePdf already wrote
      // (visionPath) and explain that in the output.
      let imagePaths: { pageNum: number; path: string }[] = []
      let canvasDegraded = false
      let degradeReason = ""
      if (analysis.visionPages.length > 0) {
        try {
          imagePaths = await renderPagesToImages(filePath, analysis.visionPages, onProgress)
        } catch (err) {
          if (err instanceof CanvasUnavailableError) {
            canvasDegraded = true
            degradeReason = err.reason
          } else {
            throw err
          }
        }
      }

      let output =
        imagePaths.length > 0
          ? appendImageAttachmentNote(analysis.output, imagePaths)
          : canvasDegraded
            ? appendCanvasDegradedNote(analysis.output, analysis.visionPath, degradeReason)
            : analysis.output
      if (canvasProgressNotes.length > 0) {
        output = appendCanvasDownloadNote(output, canvasProgressNotes)
      }

      return {
        title: path.relative(Instance.worktree, filePath),
        output,
        // No `truncated` field on purpose, so Tool.define truncates the output (20 pages in auto mode can exceed
        // 50KB).
        metadata: {
          file: path.basename(filePath),
          mode: params.mode ?? "auto",
          pages: params.pages ?? "1-10",
          renderedPages: imagePaths.map((item) => item.pageNum),
          canvasDegraded,
        },
        attachments: imagePaths.map((item) => ({
          id: Identifier.ascending("part"),
          sessionID: ctx.sessionID,
          messageID: ctx.messageID,
          type: "file" as const,
          mime: "image/png",
          url: `data:image/png;base64,${fs.readFileSync(item.path).toString("base64")}`,
        })),
      }
    },
  },
  // Search keywords for deferred loading (see Tool.Info.triggerHint); scored but never sent in the prompt. They mix
  // Chinese and English so Chinese queries can reach the English tool id pdf_parse. Only domain-specific words are
  // listed: generic words like "parse", "extract", "read", "document" or "report" match many unrelated requests,
  // and a strong match activates the tool automatically, wasting a schema slot, so misses are preferred.
  "pdf 论文 文献 扫描件 说明书 手册",
)

function classifyPage(text: string, hasImages: boolean, hasTableHint: boolean, mode: Mode): PageType {
  if (mode === "text") return text.length >= 10 ? "text" : "empty"
  const len = text.length
  if (len < 10 && !hasImages && !hasTableHint) return "empty"
  if (hasTableHint) return "table"
  if (hasImages && len < 100) return "image"
  if (hasImages) return "mixed"
  return "text"
}

function isImageOp(ops: Record<string, number>, fn: number): boolean {
  return [
    ops.paintImageXObject,
    ops.paintJpegXObject,
    ops.paintInlineImageXObject,
    ops.paintImageMaskXObject,
    ops.paintXObject,
  ].some((op) => op !== undefined && fn === op)
}

function layoutText(items: unknown[]): string {
  if (!items.length) return ""
  const Y_TOL = 3
  const lines = new Map<number, { x: number; str: string }[]>()
  for (const item of items) {
    if (!isTextItem(item) || !item.str || !item.transform || item.transform.length < 6) continue
    const y = Math.round(item.transform[5] / Y_TOL) * Y_TOL
    const x = item.transform[4]
    if (!lines.has(y)) lines.set(y, [])
    lines.get(y)!.push({ x, str: item.str })
  }
  return [...lines.keys()]
    .sort((a, b) => b - a)
    .map((y) =>
      lines
        .get(y)!
        .sort((a, b) => a.x - b.x)
        .map((i) => i.str)
        .join(" "),
    )
    .join("\n")
}

function isTextItem(item: unknown): item is TextItem {
  if (!item || typeof item !== "object") return false
  const value = item as { str?: unknown; transform?: unknown }
  if (value.str !== undefined && typeof value.str !== "string") return false
  if (!Array.isArray(value.transform)) return false
  return value.transform.every((n) => typeof n === "number")
}

async function splitPages(filePath: string, pageNums: number[]): Promise<string> {
  const tmpDir = path.join(os.tmpdir(), "mc-pdf")
  fs.mkdirSync(tmpDir, { recursive: true })
  const baseName = path.basename(filePath, ".pdf")
  const outPath = path.join(tmpDir, `${baseName}_${Date.now()}.pdf`)

  // Prefer qpdf (streaming, low memory) when it is installed.
  try {
    const { spawnSync } = await import("child_process")
    const qpdfRange = pageNums.join(",")
    const result = spawnSync("qpdf", [filePath, "--pages", ".", qpdfRange, "--", outPath], {
      timeout: 30000,
      stdio: "pipe",
    })
    if (result.status === 0 && fs.existsSync(outPath)) return outPath
  } catch {
    /* qpdf not available */
  }

  // pdf-lib loads the whole file but always ships with the engine.
  const { PDFDocument } = await import("pdf-lib")
  const pdfBytes = fs.readFileSync(filePath)
  const pdfDoc = await PDFDocument.load(pdfBytes, { ignoreEncryption: true })
  const newPdf = await PDFDocument.create()
  const indices = pageNums.map((n) => n - 1)
  const copiedPages = await newPdf.copyPages(pdfDoc, indices)
  copiedPages.forEach((p) => newPdf.addPage(p))
  fs.writeFileSync(outPath, await newPdf.save())
  return outPath
}

async function renderPagesToImages(
  filePath: string,
  pageNums: number[],
  onProgress?: (msg: string) => void,
): Promise<{ pageNum: number; path: string }[]> {
  // analyzePdf already prepared canvas (idempotent, cached here). If that attempt failed silently, retry; on failure
  // throw CanvasUnavailableError so execute falls back to the split-page PDF.
  const prepared = await prepareCanvasForPdfjs(onProgress)
  if (!prepared.ok) {
    throw new CanvasUnavailableError(prepared.reason)
  }
  const canvas = prepared.canvas
  loadSystemFonts(canvas)
  const { task, doc } = await open(filePath, createPdfCanvasFactory(canvas))

  const tmpDir = path.join(os.tmpdir(), "mc-pdf-images")
  fs.mkdirSync(tmpDir, { recursive: true })
  const baseName = path.basename(filePath, ".pdf")

  try {
    const result: { pageNum: number; path: string }[] = []
    for (const pageNum of pageNums) {
      const page = await doc.getPage(pageNum)
      const viewport = page.getViewport({ scale: 2 })
      const image = canvas.createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height))
      // @napi-rs/canvas is not a DOM canvas (no drawFocusIfNeeded etc.), but pdfjs only uses the part it implements.
      await page.render({ canvas: image as unknown as HTMLCanvasElement, viewport }).promise
      const buffer = await encodePng(image)
      const outPath = path.join(tmpDir, `${baseName}_${Date.now()}_page-${pageNum}.png`)
      fs.writeFileSync(outPath, buffer)
      result.push({ pageNum, path: outPath })
    }
    return result
  } finally {
    await task.destroy()
  }
}

/**
 * Opens a PDF; release it with task.destroy(). useSystemFonts stays off: Node cannot use system fonts, and turning
 * it on stops pdfjs from loading its bundled standard fonts, so glyphs that are not embedded would not render.
 */
async function open(filePath: string, CanvasFactory?: ReturnType<typeof createPdfCanvasFactory>) {
  const { pdfjs, assets } = await loadPdfjsRuntime()
  const task = pdfjs.getDocument({
    url: pathToFileURL(filePath).href,
    disableWorker: true,
    verbosity: pdfjs.VerbosityLevel.ERRORS,
    ...assets,
    ...(CanvasFactory ? { CanvasFactory } : {}),
  } as Parameters<typeof pdfjs.getDocument>[0])
  return { pdfjs, task, doc: await task.promise }
}

function createPdfCanvasFactory(canvas: typeof import("@napi-rs/canvas")) {
  return class MerakCodeCanvasFactory {
    create(width: number, height: number) {
      if (width <= 0 || height <= 0) throw new Error("Invalid canvas size")
      const item = canvas.createCanvas(width, height)
      return {
        canvas: item,
        context: item.getContext("2d"),
      }
    }

    reset(item: { canvas: { width: number; height: number } | null }, width: number, height: number) {
      if (!item.canvas) throw new Error("Canvas is not specified")
      if (width <= 0 || height <= 0) throw new Error("Invalid canvas size")
      item.canvas.width = width
      item.canvas.height = height
    }

    destroy(item: { canvas: { width: number; height: number } | null; context: unknown }) {
      if (!item.canvas) throw new Error("Canvas is not specified")
      item.canvas.width = 0
      item.canvas.height = 0
      item.canvas = null
      item.context = null
    }
  }
}

async function encodePng(canvas: any): Promise<Buffer> {
  if (typeof canvas.encode === "function") return Buffer.from(await canvas.encode("png"))
  if (typeof canvas.toBuffer === "function") return Buffer.from(canvas.toBuffer("image/png"))
  throw new Error("@napi-rs/canvas did not expose a PNG encoder")
}

function appendImageAttachmentNote(output: string, imagePaths: { pageNum: number; path: string }[]) {
  return [
    output,
    "",
    `=== Rendered Images Attached (Pages ${imagePaths.map((item) => item.pageNum).join(", ")}) ===`,
    ...imagePaths.map((item) => `Page ${item.pageNum}: ${item.path}`),
  ].join("\n")
}

/** Explains that PNG rendering failed and points to the split-page PDF for models with PDF input. */
function appendCanvasDegradedNote(output: string, visionPath: string | null, reason: string): string {
  const lines: string[] = []
  lines.push("")
  lines.push("=== PDF vision renderer unavailable ===")
  lines.push(`PNG images could not be rendered this time (@napi-rs/canvas failed to download/load: ${reason}).`)
  if (visionPath) {
    lines.push(
      "The visual pages were split into a separate PDF that a multimodal model with PDF input can read directly:",
    )
    lines.push(`File: ${visionPath}`)
    lines.push(`View: read(filePath: "${visionPath}")`)
  } else {
    lines.push(
      'The visual pages could not be split into a separate PDF; retry with mode="vision" to get a split-page PDF.',
    )
  }
  lines.push(
    "For PNG images, check the network and retry (first use downloads a ~37MB renderer, which is cached afterwards).",
  )
  return [output, ...lines].join("\n")
}

/** Appends canvas download progress; only called when this parse actually downloaded the renderer. */
function appendCanvasDownloadNote(output: string, notes: string[]): string {
  return [output, "", "=== PDF vision renderer (downloaded for the first time) ===", ...notes].join("\n")
}

function formatVisionOnly(filePath: string, total: number, pageNums: number[], outPath: string): string {
  const sizeMB = (fs.statSync(outPath).size / 1024 / 1024).toFixed(1)
  const lines: string[] = []
  lines.push(`PDF: ${path.basename(filePath)} | Total: ${total} pages | Mode: vision`)
  lines.push("")
  lines.push(`=== Vision Suggested (Pages ${pageNums.join(", ")}) ===`)
  lines.push(`All requested pages split for visual reading.`)
  lines.push(`File: ${outPath} (${sizeMB}MB)`)
  lines.push(`View: read(filePath: "${outPath}")`)
  lines.push(`NOTE: Requires model with image/pdf input support.`)
  return lines.join("\n")
}

function formatOutput(
  filePath: string,
  total: number,
  results: PageResult[],
  visionPath: string | null,
  mode: Mode,
  maxChars: number,
): string {
  const lines: string[] = []
  lines.push(`PDF: ${path.basename(filePath)} | Total: ${total} pages | Mode: ${mode}`)
  lines.push("")

  const textPages = results.filter((p) => ["text", "mixed", "table"].includes(p.type))
  if (textPages.length > 0) {
    lines.push(`=== Text Extracted ===`)
    for (const p of textPages) {
      const suffix =
        p.type === "mixed"
          ? " (also has images)"
          : p.type === "table"
            ? " (table/layout hint - columns may be misaligned)"
            : ""
      lines.push(`--- Page ${p.pageNum}${suffix} ---`)
      const text = p.text || "(no text)"
      if (text.length > maxChars) {
        lines.push(text.slice(0, maxChars))
        lines.push(`[...truncated at ${maxChars} chars, ${text.length} total]`)
      } else {
        lines.push(text)
      }
      lines.push("")
    }
  }

  const visionSuggested = results.filter((p) => ["image", "mixed", "table"].includes(p.type))
  if (visionPath && visionSuggested.length > 0) {
    const sizeMB = (fs.statSync(visionPath).size / 1024 / 1024).toFixed(1)
    lines.push(`=== Vision Suggested (Pages ${visionSuggested.map((p) => p.pageNum).join(", ")}) ===`)
    for (const p of visionSuggested) {
      const reason =
        p.type === "image"
          ? "image content"
          : p.type === "table"
            ? "table/layout hint (text above may lose column alignment)"
            : "mixed text+image"
      lines.push(`  Page ${p.pageNum}: ${reason}`)
    }
    lines.push(`File: ${visionPath} (${sizeMB}MB)`)
    lines.push(`View: read(filePath: "${visionPath}")`)
    lines.push(`NOTE: Requires model with image/pdf input support.`)
    lines.push("")
  }

  const emptyPages = results.filter((p) => p.type === "empty")
  if (emptyPages.length > 0) {
    lines.push(`=== Empty (Pages ${emptyPages.map((p) => p.pageNum).join(", ")}) ===`)
  }

  return lines.join("\n")
}

function parsePageRange(range: string, total: number): number[] {
  const result: number[] = []
  for (const part of range.split(",")) {
    const t = part.trim()
    if (!t) continue
    if (t.includes("-")) {
      const [sStr, eStr, extra] = t.split("-")
      if (extra !== undefined) throw new Error(`Invalid range: "${t}"`)
      const s = Number(sStr)
      const e = Number(eStr)
      if (!Number.isInteger(s) || !Number.isInteger(e)) throw new Error(`Invalid range: "${t}"`)
      if (s > e) throw new Error(`Reversed range: "${t}" (start > end)`)
      if (s < 1) throw new Error(`Page number must be >= 1: "${t}"`)
      for (let i = s; i <= Math.min(e, total); i++) result.push(i)
    } else {
      const n = Number(t)
      if (!Number.isInteger(n)) throw new Error(`Invalid page: "${t}"`)
      if (n >= 1 && n <= total) result.push(n)
    }
  }
  if (result.length === 0) throw new Error(`No valid pages in "${range}" (total: ${total})`)
  return [...new Set(result)].sort((a, b) => a - b)
}
