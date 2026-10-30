import z from "zod"
import * as fs from "fs"
import * as path from "path"
import { Tool } from "./tool"
import DESCRIPTION from "./docx-parse.txt"
import { Instance } from "../../infra/project/instance"
import { Workspace } from "../../infra/project/workspace"
import { Identifier } from "@merakcode/util/id"
import { formatDocxDocument, parseDocxDocument, type DocxParseOptions } from "./document/docx/parse"
import { Log } from "@merakcode/log/logger"
import { failure } from "@merakcode/log"
import { PermissionPolicy } from "../permission/policy"

const log = Log.create({ service: "docx.parse" })

/**
 * Built-in Word reader.
 *
 * Like pdf_parse / excel_parse, parsing lives in the pure functions parseDocxDocument / formatDocxDocument
 * (../docx/parse), which ship inside the binary and behave the same on every platform, with no external scripts or
 * system libraries, so it also works without internet access.
 *
 * - Parameters mirror DocxParseOptions plus filePath and json.
 * - Images are returned as attachments (data URLs); the text marks their position with [Image: xxx.png].
 */

/** Parses `blocks: "start:end"` (1-based, inclusive). Returns undefined when not given. */
function parseBlockRange(value: string | undefined): DocxParseOptions["blockRange"] {
  if (!value) return undefined
  const match = value.match(/^(\d+):(\d+)$/)
  if (!match) {
    throw new Error(`Invalid blocks range: expected <start>:<end> (e.g. "1:100"), got "${value}"`)
  }
  const start = Number(match[1])
  const end = Number(match[2])
  if (end < start) {
    throw new Error(`Invalid blocks range: start must be <= end, got "${value}"`)
  }
  return { start, end }
}

export const DocxParseTool = Tool.define(
  "docx_parse",
  {
    description: DESCRIPTION,
    parameters: z.object({
      filePath: z
        .string()
        .describe("Absolute path to the .docx file (relative paths resolve against the project directory)"),
      blocks: z
        .string()
        .optional()
        .describe('1-based closed block range to read, e.g. "1:100". Useful for paging large documents.'),
      extractImages: z
        .boolean()
        .optional()
        .describe("Extract embedded raster images (png/jpeg/gif/bmp) as attachments. Default true."),
      maxChars: z.number().min(500).max(30000).optional().describe("Max text chars in output. Default 6000."),
      json: z
        .boolean()
        .optional()
        .describe("Print the parsed document as JSON instead of formatted text, for structured follow-up analysis."),
    }),
    async execute(params, ctx) {
      // Relative paths resolve against the primary root; absolute ones may be in any workspace folder, as in read/write
      const filePath = Workspace.resolveToolPath(Instance.workspace, params.filePath).filepath
      if (!fs.existsSync(filePath)) throw new Error(`File not found: ${filePath}`)

      // Access outside the workspace is blocked by the sandbox, not asked about here
      await ctx.ask({
        permission: "read",
        checks: [PermissionPolicy.file({ op: "read", path: filePath, ...PermissionPolicy.scope() })],
        metadata: { filepath: filePath },
      })

      const range = parseBlockRange(params.blocks)
      const started = Date.now()
      const fields = {
        sessionID: ctx.sessionID,
        bytes: fs.statSync(filePath).size,
        ranged: !!range,
        extractImages: params.extractImages !== false,
        maxChars: params.maxChars ?? 6000,
        output: params.json ? "json" : "text",
      }
      log.info("DOCX parse started", fields)
      const doc = await parseDocxDocument(filePath, {
        blockRange: range,
        extractImages: params.extractImages,
        maxChars: params.maxChars,
      }).then(
        (result) => {
          log.info("DOCX parse completed", {
            ...fields,
            duration: Date.now() - started,
            blocks: result.blocks.length,
            tables: result.tables.length,
            images: result.images.length,
            truncated: result.truncated,
            warnings: result.warnings.length,
          })
          return result
        },
        (error) => {
          log.error("DOCX parse failed", { ...fields, duration: Date.now() - started, ...failure(error) })
          throw error
        },
      )

      return {
        title: path.relative(Instance.worktree, filePath),
        output: params.json ? JSON.stringify(doc, null, 2) : formatDocxDocument(doc),
        // No truncated field on purpose, so the Tool.define wrapper runs Truncate.output
        metadata: {
          file: path.basename(filePath),
          blocks: doc.blocks.length,
          tables: doc.tables.length,
          images: doc.images.length,
          json: params.json === true,
        },
        attachments: doc.images
          .filter((img) => img.path)
          .map((img) => ({
            id: Identifier.ascending("part"),
            sessionID: ctx.sessionID,
            messageID: ctx.messageID,
            type: "file" as const,
            mime: img.mime,
            filename: img.name,
            url: `data:${img.mime};base64,${fs.readFileSync(img.path!).toString("base64")}`,
          })),
      }
    },
  },
  // Search terms for deferred loading (see Tool.Info.triggerHint), used for scoring only. Chinese terms let a Chinese
  // query such as "parse this contract" match the English id docx_parse. Only domain words, no generic verbs such as
  // read or parse: a strong match activates the tool automatically, so false hits must stay rare.
  "word docx doc 文档 合同 报告 简历 稿件 说明书 通知",
)
