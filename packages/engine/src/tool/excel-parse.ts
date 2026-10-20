import z from "zod"
import * as fs from "fs"
import * as path from "path"
import { Tool } from "./tool"
import DESCRIPTION from "./excel-parse.txt"
import { Instance } from "../project/instance"
import { Workspace } from "../project/workspace"
import { formatExcelWorkbook, parseExcelWorkbook, type ExcelRowRange } from "../excel/parse"
import { PermissionPolicy } from "../permission/policy"

/**
 * Built-in Excel reader.
 *
 * A script written by the model to read Excel would depend on runtimes and packages on the user's machine, and the
 * release has no script to call. So reading is a built-in tool, like pdf_parse: it calls the pure functions
 * `parseExcelWorkbook` / `formatExcelWorkbook` from `../excel/parse`, which ship inside the binary and behave the same
 * on every platform.
 *
 * - Parameters mirror ExcelParseOptions plus filePath and json.
 * - Output is truncated by Truncate.output in the Tool.define wrapper, since large workbooks may exceed the limit.
 */

/** Parses `rows: "start:end"` (1-based, inclusive). Returns undefined when not given. */
function parseRowRange(value: string | undefined): ExcelRowRange | undefined {
  if (!value) return undefined
  const match = value.match(/^(\d+):(\d+)$/)
  if (!match) {
    throw new Error(`Invalid rows range: expected <start>:<end> (e.g. "1001:2000"), got "${value}"`)
  }
  const start = Number(match[1])
  const end = Number(match[2])
  if (end < start) {
    throw new Error(`Invalid rows range: start must be <= end, got "${value}"`)
  }
  return { start, end }
}

export const ExcelParseTool = Tool.define(
  "excel_parse",
  {
    description: DESCRIPTION,
    parameters: z.object({
      filePath: z
        .string()
        .describe("Absolute path to the .xlsx/.xlsm workbook (relative paths resolve against the project directory)"),
      sheets: z
        .array(z.string())
        .optional()
        .describe("Worksheet names or 1-based indexes to inspect. If omitted, inspects up to maxSheets worksheets."),
      maxSheets: z.number().int().min(1).optional().describe("Maximum worksheets to inspect. Default 20."),
      maxRows: z.number().int().min(1).optional().describe("Maximum rows to show per sheet. Default 100."),
      maxCells: z.number().int().min(1).optional().describe("Maximum cells to scan per sheet. Default 2000."),
      rows: z
        .string()
        .optional()
        .describe('1-based closed row range to read, e.g. "1001:2000". Useful for paging large sheets.'),
      summary: z
        .boolean()
        .optional()
        .describe("Only output each sheet's dimension and header row. Good for a quick overview of large workbooks."),
      json: z
        .boolean()
        .optional()
        .describe("Print the parsed workbook as JSON instead of formatted text, for structured follow-up analysis."),
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

      const workbook = await parseExcelWorkbook(filePath, {
        sheets: params.sheets,
        maxSheets: params.maxSheets,
        maxRowsPerSheet: params.maxRows,
        maxCellsPerSheet: params.maxCells,
        rowRange: parseRowRange(params.rows),
        summaryOnly: params.summary,
      })

      const output = params.json ? JSON.stringify(workbook, null, 2) : formatExcelWorkbook(workbook)

      return {
        title: path.relative(Instance.worktree, filePath),
        output,
        // No truncated field on purpose, so the Tool.define wrapper runs Truncate.output
        metadata: {
          file: path.basename(filePath),
          format: workbook.format,
          sheets: workbook.sheets.length,
          json: params.json === true,
          summary: params.summary === true,
        },
      }
    },
  },
  // Search terms for deferred loading (see Tool.Info.triggerHint), used for scoring only. Only domain words, no
  // generic verbs such as read or parse: a strong match activates the tool automatically, so false hits must stay
  // rare. The overlap with excel_write is deliberate: when the read or write intent is unclear both are activated
  // (within the cap), which is more reliable than guessing from generic verbs.
  "excel xlsx xlsm csv 表格 报表 电子表格 工作簿 数据表 sheet",
)
