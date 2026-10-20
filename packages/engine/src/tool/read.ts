import z from "zod"
import * as fs from "fs"
import * as path from "path"
import { Tool } from "./tool"
import { LSP } from "../lsp"
import { FileTime } from "../file/time"
import { RuleSession } from "../rule/session-state"
import DESCRIPTION from "./read.txt"
import { Instance } from "../project/instance"
import { Workspace } from "../project/workspace"
import { Identifier } from "@merakcode/util/id"
import { ContextAttach } from "../session/context-attach"
import * as Builtin from "../skill/builtin"
import { parsePdf } from "./pdf-parse"
import type { Message } from "../session/message"
import { isProjectFileBypass } from "./file-bypass"
import { ToolPathGuard } from "./path-guard"
import { Filesystem } from "@merakcode/util/filesystem"
import { PermissionPolicy } from "../permission/policy"

const DEFAULT_READ_LIMIT = 2000
const MAX_LINE_LENGTH = 2000
const MAX_BYTES = 50 * 1024

// Chooses between reading the whole file into memory and streaming only the requested window. It is a routing
// threshold, not an output limit, so it does not interact with MAX_BYTES/MAX_LINE_LENGTH/DEFAULT_READ_LIMIT.
const STREAM_THRESHOLD_BYTES = 10 * 1024 * 1024
const BINARY_SNIFF_BYTES = 4096
// Cap on the unterminated line carried across chunks in the streaming path. It must be one more than
// MAX_LINE_LENGTH: a line cut to exactly MAX_LINE_LENGTH would fail clampLine's `length > MAX_LINE_LENGTH` check
// and lose its ellipsis.
const CARRY_LIMIT = MAX_LINE_LENGTH + 1

export const ReadTool = Tool.define("read", {
  description: DESCRIPTION,
  parameters: z.object({
    filePath: z.string().describe("The absolute path to the file or directory to read"),
    offset: z.coerce.number().describe("The line number to start reading from (1-indexed)").optional(),
    limit: z.coerce.number().describe("The maximum number of lines to read (defaults to 2000)").optional(),
  }),
  async execute(params, ctx) {
    if (params.offset !== undefined && params.offset < 1) {
      throw new Error("offset must be greater than or equal to 1")
    }

    // Built-in skill files are served from memory without touching the filesystem. No ctx.ask is needed:
    // builtin-skill:// is not a disk path, and the skill tool has already authorized loading the skill.
    if (params.filePath.startsWith("builtin-skill://")) {
      return readBuiltinSkillFile(params)
    }

    const resolved = Workspace.resolveToolPath(Instance.workspace, params.filePath)
    const filepath = resolved.filepath
    await ToolPathGuard.assertPathAllowed(ctx, filepath, "read")
    const title = Workspace.displayPath(Instance.workspace, filepath)

    const stat = await fs.promises.stat(filepath).catch(() => undefined)
    const mime = Filesystem.mimeType(filepath)

    // Project-owned side files such as memory and generated plans live outside the worktree,
    // but should not prompt like arbitrary external files.
    const bypass = await isProjectFileBypass({
      agent: ctx.agent,
      permissionMode: ctx.permissionMode,
      filePath: filepath,
      sessionID: ctx.sessionID,
      access: "read",
    })
    if (!bypass) {
      await ctx.ask({
        permission: "read",
        checks: [PermissionPolicy.file({ op: "read", path: filepath, ...PermissionPolicy.scope() })],
        metadata: { filepath },
      })
    }

    if (!stat) {
      const dir = path.dirname(filepath)
      const base = path.basename(filepath)

      const dirEntries = fs.readdirSync(dir)
      const suggestions = dirEntries
        .filter(
          (entry) =>
            entry.toLowerCase().includes(base.toLowerCase()) || base.toLowerCase().includes(entry.toLowerCase()),
        )
        .map((entry) => path.join(dir, entry))
        .slice(0, 3)

      if (suggestions.length > 0) {
        throw new Error(`File not found: ${filepath}\n\nDid you mean one of these?\n${suggestions.join("\n")}`)
      }

      throw new Error(`File not found: ${filepath}`)
    }

    if (stat.isDirectory()) {
      const dirents = await fs.promises.readdir(filepath, { withFileTypes: true })
      const entries = await Promise.all(
        dirents.map(async (dirent) => {
          if (dirent.isDirectory()) return dirent.name + "/"
          if (dirent.isSymbolicLink()) {
            const target = await fs.promises.stat(path.join(filepath, dirent.name)).catch(() => undefined)
            if (target?.isDirectory()) return dirent.name + "/"
          }
          return dirent.name
        }),
      )
      entries.sort((a, b) => a.localeCompare(b))

      const limit = params.limit ?? DEFAULT_READ_LIMIT
      const offset = params.offset ?? 1
      const start = offset - 1
      const sliced = entries.slice(start, start + limit)
      const truncated = start + sliced.length < entries.length

      const output = [
        `<path>${filepath}</path>`,
        `<type>directory</type>`,
        `<entries>`,
        sliced.join("\n"),
        truncated
          ? `\n(Showing ${sliced.length} of ${entries.length} entries. Use 'offset' parameter to read beyond entry ${offset + sliced.length})`
          : `\n(${entries.length} entries)`,
        `</entries>`,
      ].join("\n")

      // Listing a directory counts as working on its files; directory=true includes the directory itself in the
      // upward walk.
      const listed = await ContextAttach.forFile({
        filepath,
        trigger: "list",
        directory: true,
        messageID: ctx.messageID,
        messages: ctx.messages,
        agent: ctx.agent,
      })

      return {
        title,
        output: output + ContextAttach.render(listed),
        metadata: {
          preview: sliced.slice(0, 20).join("\n"),
          truncated,
          loaded: listed.map((i) => i.filepath),
        },
      }
    }

    const instructions = await ContextAttach.forFile({
      filepath,
      trigger: "read",
      messageID: ctx.messageID,
      messages: ctx.messages,
      agent: ctx.agent,
    })

    // Exclude SVG (XML-based) and vnd.fastbidsheet (.fbs extension, commonly FlatBuffers schema files)
    const isImage = mime.startsWith("image/") && mime !== "image/svg+xml" && mime !== "image/vnd.fastbidsheet"
    const isPdf = mime === "application/pdf"
    if (isPdf) {
      const pdfSkill = isPdfSkillLoaded(ctx.messages)
      // Parse the first 10 pages inline with parsePdf. read has already asked for read and external_directory
      // permission, so parsePdf does not ask again. Without /pdf loaded, a parse failure falls back to the attachment
      // branch below; with /pdf loaded, the raw PDF is never attached, so models without PDF input do not fail.
      //
      // Outcomes:
      //  1. Text only: return the text.
      //  2. Vision pages and no text (scans, images): tell the user to run /pdf and hide the parsePdf details
      //     (split-page PDF path, View: read(...)) so a multimodal model does not bypass /pdf and read it itself.
      //  3. Text and vision pages: keep the extracted text so text questions can be answered, strip the
      //     File:/View:/NOTE: lines from the vision section, and append a hint to run /pdf.
      try {
        // auto mode is needed to detect image/mixed/table pages. It writes split-page PDFs to the OS temp dir
        // (mc-pdf/), which the OS cleans up; their File:/View:/NOTE: lines are stripped from the output so the
        // model does not read them and bypass /pdf.
        const output = await parsePdf(filepath, { pages: "1-10", mode: "auto" })
        const hasExtractedText = output.includes("=== Text Extracted ===")
        const hasVisionSuggested = output.includes("=== Vision Suggested ")
        const supportsPdf = modelSupportsPdf(ctx.extra?.["model"])

        if (!pdfSkill && (!hasExtractedText || hasVisionSuggested) && supportsPdf) {
          const msg = hasExtractedText
            ? [
                output,
                "",
                "--- Note ---",
                "This PDF contains images, tables, or mixed pages. The original PDF is attached and the current model accepts PDF input, so read it visually together with the attachment.",
              ].join("\n")
            : [
                `PDF detected: ${path.basename(filepath)}`,
                "",
                "This PDF has no extractable text layer. The original PDF is attached and the current model accepts PDF input, so read it visually.",
              ].join("\n")

          return {
            title,
            output: msg,
            metadata: {
              preview: msg.split("\n").slice(0, 20).join("\n"),
              truncated: false,
              loaded: instructions.map((i) => i.filepath),
            },
            attachments: [await fileAttachment(filepath, mime, ctx.sessionID, ctx.messageID)],
          }
        }

        if (pdfSkill) {
          const stripped = stripPdfVisionHints(output)
          return {
            title,
            output: [
              stripped,
              "",
              "--- PDF skill loaded ---",
              "To handle visual pages, keep calling pdf_parse instead of attaching the original PDF:",
              `pdf_parse(filePath: "${filepath}", pages: "1-10", mode: "auto")`,
              'For pages that need visual understanding, use mode="vision".',
            ].join("\n"),
            metadata: {
              preview: stripped.split("\n").slice(0, 20).join("\n"),
              truncated: false,
              loaded: instructions.map((i) => i.filepath),
            },
          }
        }

        // No text layer: read's default parameters cannot get the content, so point the user to /pdf.
        if (!hasExtractedText) {
          const hint = [
            `PDF detected: ${path.basename(filepath)}`,
            ``,
            `This PDF has no extractable text layer (it may be a scan, an image-only PDF, or use non-embedded CJK fonts),`,
            `so read's default parameters (mode=auto, pages=1-10) cannot get its content.`,
            ``,
            `Suggested next step — ask the user to run:`,
            `  /pdf      load the pdf skill for vision mode, page ranges, OCR, and other options`,
            ``,
            `Do not call the pdf_parse tool yourself or read any split-page PDF — leave the decision to the user.`,
          ].join("\n")
          return {
            title,
            output: hint,
            metadata: {
              preview: hint.split("\n").slice(0, 5).join("\n"),
              truncated: false,
              loaded: instructions.map((i) => i.filepath),
            },
          }
        }

        // Text plus image/table pages that need vision: keep the text and append a /pdf hint.
        if (hasVisionSuggested) {
          const stripped = stripPdfVisionHints(output)
          const merged = [
            stripped,
            ``,
            `--- Note ---`,
            `This PDF mixes text with images/tables: the "Text Extracted" section above holds the text,`,
            `but the pages listed under "Vision Suggested" (image / mixed / table layouts) may be incomplete from text parsing alone.`,
            `For image content, exact table reconstruction, or fuller page information:`,
            `  /pdf      load the pdf skill and follow it to split pages in vision mode for a multimodal model`,
            ``,
            `If the text above already answers the user's question, answer directly; otherwise ask the user to run /pdf.`,
            `Do not call the pdf_parse tool yourself or read split-page PDFs — leave the decision to the user.`,
          ].join("\n")
          return {
            title,
            output: merged,
            metadata: {
              preview: stripped.split("\n").slice(0, 20).join("\n"),
              truncated: false,
              loaded: instructions.map((i) => i.filepath),
            },
          }
        }

        return {
          title,
          output,
          metadata: {
            preview: output.split("\n").slice(0, 20).join("\n"),
            truncated: false,
            loaded: instructions.map((i) => i.filepath),
          },
        }
      } catch {
        if (pdfSkill) {
          const hint = [
            `PDF parsing failed: ${path.basename(filepath)}`,
            "",
            "The /pdf skill is loaded, so read will no longer attach the original application/pdf file.",
            "Once dependencies are installed, use pdf_parse for controlled parsing:",
            `pdf_parse(filePath: "${filepath}", pages: "1-10", mode: "auto")`,
            "",
            "If it still fails, the PDF rendering library may have failed to download (it is downloaded on first vision use); check the network and retry.",
          ].join("\n")
          return {
            title,
            output: hint,
            metadata: {
              preview: hint.split("\n").slice(0, 20).join("\n"),
              truncated: false,
              loaded: instructions.map((i) => i.filepath),
            },
          }
        }
        // Without /pdf loaded, fall through to the attachment branch below.
      }
    }
    if (isImage || isPdf) {
      const msg = `${isImage ? "Image" : "PDF"} read successfully`
      return {
        title,
        output: msg,
        metadata: {
          preview: msg,
          truncated: false,
          loaded: instructions.map((i) => i.filepath),
        },
        attachments: [await fileAttachment(filepath, mime, ctx.sessionID, ctx.messageID)],
      }
    }

    // Stat again: ctx.ask may have waited a long time for the user, and the file may have grown meanwhile. A stale
    // size would send a large file down the in-memory path instead of the streaming one.
    const freshStat = await fs.promises.stat(filepath).catch(() => stat)
    const fileSize = freshStat?.size ?? stat?.size ?? 0

    const isBinary = await isBinaryFile(filepath, fileSize)
    if (isBinary) throw new Error(`Cannot read binary file: ${filepath}`)

    ctx.abort.throwIfAborted()

    let { output, preview, truncated } =
      fileSize < STREAM_THRESHOLD_BYTES
        ? formatTextContent(filepath, await Filesystem.readText(filepath), params.offset, params.limit)
        : await readTextRangeStreaming(filepath, params.offset, params.limit, ctx.abort)

    // just warms the lsp client
    LSP.touchFile(filepath, false)
    FileTime.read(ctx.sessionID, filepath)
    await RuleSession.touchFromTool(ctx, filepath)

    output += ContextAttach.render(instructions)

    return {
      title,
      output,
      metadata: {
        preview,
        truncated,
        loaded: instructions.map((i) => i.filepath),
      },
    }
  },
})

function clampLine(line: string): string {
  return line.length > MAX_LINE_LENGTH ? line.substring(0, MAX_LINE_LENGTH) + "..." : line
}

/**
 * Wraps the selected lines in <path>/<type>/<content> and appends the truncation or end-of-file note. Shared by the
 * in-memory and streaming paths so their output stays identical.
 *
 * totalLines is only used when neither truncatedByBytes nor hasMoreLines is set ("End of file"), which is what lets
 * the streaming path stop early.
 */
function renderSelection(
  filepath: string,
  numberedLines: string[],
  lastReadLine: number,
  truncatedByBytes: boolean,
  hasMoreLines: boolean,
  totalLines: number | undefined,
): string {
  let output = [`<path>${filepath}</path>`, `<type>file</type>`, "<content>"].join("\n")
  output += numberedLines.join("\n")

  if (truncatedByBytes) {
    output += `\n\n(Output truncated at ${MAX_BYTES} bytes. Use 'offset' parameter to read beyond line ${lastReadLine})`
  } else if (hasMoreLines) {
    output += `\n\n(File has more lines. Use 'offset' parameter to read beyond line ${lastReadLine})`
  } else {
    output += `\n\n(End of file - total ${totalLines} lines)`
  }
  output += "\n</content>"
  return output
}

/**
 * Formats a window of in-memory text with line numbers and byte/line truncation notes. Pure: no LSP, FileTime,
 * permission or instruction side effects. Used for disk files and builtin-skill:// files.
 */
function formatTextContent(
  filepath: string,
  content: string,
  offsetParam?: number,
  limitParam?: number,
): { output: string; preview: string; truncated: boolean } {
  const offset = offsetParam ?? 1
  const limit = limitParam ?? DEFAULT_READ_LIMIT
  const lines = content.split("\n")
  const start = offset - 1
  if (start >= lines.length) {
    throw new Error(`Offset ${offset} is out of range for this file (${lines.length} lines)`)
  }

  const raw: string[] = []
  let bytes = 0
  let truncatedByBytes = false
  for (let i = start; i < Math.min(lines.length, start + limit); i++) {
    const line = clampLine(lines[i])
    const size = Buffer.byteLength(line, "utf-8") + (raw.length > 0 ? 1 : 0)
    if (bytes + size > MAX_BYTES) {
      truncatedByBytes = true
      break
    }
    raw.push(line)
    bytes += size
  }

  const numbered = raw.map((line, index) => `${index + offset}: ${line}`)
  const preview = raw.slice(0, 20).join("\n")

  const totalLines = lines.length
  const lastReadLine = offset + raw.length - 1
  const hasMoreLines = totalLines > lastReadLine
  const truncated = hasMoreLines || truncatedByBytes

  const output = renderSelection(filepath, numbered, lastReadLine, truncatedByBytes, hasMoreLines, totalLines)
  return { output, preview, truncated }
}

/**
 * Single-pass streaming read for files of at least STREAM_THRESHOLD_BYTES. Memory grows with the selected window,
 * not with the file size:
 * - Lines before the window only advance currentLine.
 * - Lines in the window are clamped and collected; hitting MAX_BYTES sets truncatedByBytes and stops at once.
 * - Once the window is full, any remaining byte means more lines; there is no need to wait for a full line, which
 *   keeps reading line 1 of a huge single-line file cheap.
 * - An exact totalLines is only needed when the stream ends before the window is full (offset out of range, or the
 *   "End of file" note).
 */
async function readTextRangeStreaming(
  filepath: string,
  offsetParam: number | undefined,
  limitParam: number | undefined,
  signal: AbortSignal,
): Promise<{ output: string; preview: string; truncated: boolean }> {
  const offset = offsetParam ?? 1
  const limit = limitParam ?? DEFAULT_READ_LIMIT
  const windowStart = offset - 1 // 0-indexed, inclusive
  const windowEnd = windowStart + limit // 0-indexed, exclusive

  signal.throwIfAborted()

  const stream = fs.createReadStream(filepath, { highWaterMark: 512 * 1024, signal })
  const decoder = new TextDecoder()

  const selected: string[] = []
  let selectedBytes = 0
  let truncatedByBytes = false
  let hasMoreLines = false
  let currentLine = 0 // lines terminated by \n so far
  let partial = "" // only kept while currentLine is inside the window
  let windowComplete = false // all `limit` lines of the window are collected
  let stopped = false // the result is known, stop reading
  let reachedRealEof = false

  const pushLine = (line: string) => {
    const clipped = clampLine(line)
    const sep = selected.length > 0 ? 1 : 0
    const size = Buffer.byteLength(clipped, "utf-8") + sep
    if (selectedBytes + size > MAX_BYTES) {
      truncatedByBytes = true
      stopped = true
      return
    }
    selected.push(clipped)
    selectedBytes += size
  }

  const abortHandler = () => {
    if (!stream.destroyed) stream.destroy(new Error("Read aborted"))
  }
  signal.addEventListener("abort", abortHandler, { once: true })

  try {
    outer: for await (const rawChunk of stream) {
      signal.throwIfAborted()
      const decoded = partial + decoder.decode(rawChunk as Buffer, { stream: true })
      partial = ""
      let cursor = 0

      if (!windowComplete) {
        let nl: number
        while ((nl = decoded.indexOf("\n", cursor)) !== -1) {
          if (currentLine >= windowStart) pushLine(decoded.slice(cursor, nl))
          currentLine++
          cursor = nl + 1
          if (stopped) break outer // truncated by bytes, nothing else is needed
          if (currentLine >= windowEnd) {
            windowComplete = true
            break
          }
        }
        if (!windowComplete && cursor < decoded.length) {
          const rest = decoded.slice(cursor)
          partial = rest.length > CARRY_LIMIT ? rest.slice(0, CARRY_LIMIT) : rest
        }
      }

      // Once the window is full, any remaining byte means there are more lines.
      if (windowComplete && cursor < decoded.length) {
        hasMoreLines = true
        stopped = true
        break outer
      }
      // Window full exactly at a chunk boundary: the next chunk or the end of the stream decides.
    }
    if (!stopped) reachedRealEof = true
  } finally {
    signal.removeEventListener("abort", abortHandler)
    if (!stream.destroyed) stream.destroy()
  }

  signal.throwIfAborted()

  if (reachedRealEof && !windowComplete) {
    // The stream ended before the window filled: flush the remainder as the last line, matching split("\n").
    const tail = partial + decoder.decode()
    if (currentLine >= windowStart && currentLine < windowEnd) pushLine(tail)
    currentLine++
    if (windowStart >= currentLine) {
      throw new Error(`Offset ${offset} is out of range for this file (${currentLine} lines)`)
    }
  }
  // Otherwise the read stopped on the byte limit, hasMoreLines is known, or the file ended exactly at the window
  // boundary (hasMoreLines correctly stays false).

  const numbered = selected.map((line, index) => `${index + offset}: ${line}`)
  const preview = selected.slice(0, 20).join("\n")
  const lastReadLine = offset + selected.length - 1
  const totalLines = reachedRealEof && !hasMoreLines && !truncatedByBytes ? currentLine : undefined

  const output = renderSelection(filepath, numbered, lastReadLine, truncatedByBytes, hasMoreLines, totalLines)
  return { output, preview, truncated: hasMoreLines || truncatedByBytes }
}

/**
 * Reads a built-in skill file from memory. URI format: builtin-skill://<skill-name>/<filename>
 *
 * - A leading `./` is stripped (models often copy `./space.md` from SKILL.md).
 * - `..` is rejected so one skill cannot reach another.
 * - Nested paths are rejected; built-in skill files are flat.
 */
async function readBuiltinSkillFile(params: { filePath: string; offset?: number; limit?: number }) {
  const match = params.filePath.match(/^builtin-skill:\/\/([^/]+)\/(.+)$/)
  if (!match) {
    throw new Error(`Invalid builtin-skill URI: ${params.filePath}`)
  }
  const [, skillName, rawFileName] = match

  const fileName = rawFileName.replace(/^\.\//, "")
  if (fileName.startsWith("..") || fileName.includes("/..")) {
    throw new Error(`Path traversal not allowed in builtin-skill URI: ${rawFileName}`)
  }
  if (fileName.includes("/")) {
    throw new Error(`Nested paths not supported in builtin-skill URI: ${rawFileName}`)
  }

  const builtin = Builtin.getBuiltinSkill(skillName)
  const content = builtin?.files?.[fileName]
  if (content === undefined) {
    const available = Object.keys(builtin?.files ?? {}).join(", ") || "none"
    throw new Error(`Builtin skill file not found: ${params.filePath}. Available files: ${available}`)
  }

  const { output, preview, truncated } = formatTextContent(params.filePath, content, params.offset, params.limit)

  return {
    title: params.filePath,
    output,
    metadata: {
      preview,
      truncated,
      loaded: [] as string[],
    },
  }
}

function modelSupportsPdf(model: unknown): boolean {
  if (!model || typeof model !== "object") return false
  const capabilities = (model as { capabilities?: unknown }).capabilities
  if (!capabilities || typeof capabilities !== "object") return false
  const input = (capabilities as { input?: unknown }).input
  if (!input || typeof input !== "object") return false
  return (input as { pdf?: unknown }).pdf === true
}

function isPdfSkillLoaded(messages: Message.FullMsg[]): boolean {
  return messages.some(
    (message) =>
      message.info.role === "user" &&
      typeof message.info.system === "string" &&
      // The second phrase is the older Chinese wording, still present in existing sessions.
      (message.info.system.includes('You have loaded the "pdf" skill') ||
        message.info.system.includes('你已加载 "pdf" skill')),
  )
}

function stripPdfVisionHints(output: string): string {
  return output
    .split("\n")
    .filter((line) => {
      const trimmed = line.trim()
      return (
        !trimmed.startsWith("File: ") &&
        !trimmed.startsWith("View: read(") &&
        !trimmed.startsWith("NOTE: Requires model")
      )
    })
    .join("\n")
}

async function fileAttachment(filepath: string, mime: string, sessionID: string, messageID: string) {
  return {
    id: Identifier.ascending("part"),
    sessionID,
    messageID,
    type: "file" as const,
    mime,
    url: `data:${mime};base64,${Buffer.from(await Filesystem.readBytes(filepath)).toString("base64")}`,
  }
}

/**
 * Detects binary files by extension, then by sniffing at most BINARY_SNIFF_BYTES from the start of the file.
 * fileSize comes from the caller's fresh stat.
 */
async function isBinaryFile(filepath: string, fileSize: number): Promise<boolean> {
  const ext = path.extname(filepath).toLowerCase()
  // binary check for common non-text extensions
  switch (ext) {
    case ".zip":
    case ".tar":
    case ".gz":
    case ".exe":
    case ".dll":
    case ".so":
    case ".class":
    case ".jar":
    case ".war":
    case ".7z":
    case ".doc":
    case ".docx":
    case ".xls":
    case ".xlsx":
    case ".ppt":
    case ".pptx":
    case ".odt":
    case ".ods":
    case ".odp":
    case ".bin":
    case ".dat":
    case ".obj":
    case ".o":
    case ".a":
    case ".lib":
    case ".wasm":
    case ".pyc":
    case ".pyo":
      return true
    default:
      break
  }

  if (fileSize === 0) return false

  const bufferSize = Math.min(BINARY_SNIFF_BYTES, fileSize)
  const bytes = await Filesystem.readRange(filepath, 0, bufferSize)
  if (bytes.byteLength === 0) return false

  let nonPrintableCount = 0
  for (let i = 0; i < bytes.length; i++) {
    if (bytes[i] === 0) return true
    if (bytes[i] < 9 || (bytes[i] > 13 && bytes[i] < 32)) {
      nonPrintableCount++
    }
  }
  // If >30% non-printable characters, consider it binary
  return nonPrintableCount / bytes.length > 0.3
}
