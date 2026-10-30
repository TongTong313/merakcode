import z from "zod"
import * as path from "path"
import { Tool } from "./tool"
import DESCRIPTION from "./excel-write.txt"
import { Instance } from "../../infra/project/instance"
import { Workspace } from "../../infra/project/workspace"
import { writeExcelWorkbook, type WriteWorkbook } from "./document/excel/write"
import { FileTime } from "../../infra/file/time"
import { Snapshot } from "../../infra/project/snapshot"
import { PermissionPolicy } from "../permission/policy"

/**
 * Built-in Excel writer.
 *
 * Like excel_parse, it calls the pure function `writeExcelWorkbook` from `../excel/write` and ships inside the binary,
 * with no external script path.
 *
 * - Parameters are structured sheets/rows validated by zod rather than a JSON string, so the model passes data
 *   directly instead of writing a JSON file and running it through bash.
 * - Only creates new workbooks; null cells are skipped and column references keep the alignment.
 */

// A cell is string | number | boolean | null; null cells are skipped and column references keep the alignment
const cellSchema = z.union([z.string(), z.number(), z.boolean(), z.null()])

const sheetSchema = z.object({
  name: z.string().min(1).describe("Worksheet name"),
  rows: z
    .array(z.array(cellSchema))
    .describe(
      "Rows of cells. Each cell is string | number | boolean | null. null cells are skipped (alignment preserved).",
    ),
})

export const ExcelWriteTool = Tool.define(
  "excel_write",
  {
    description: DESCRIPTION,
    parameters: z.object({
      output: z
        .string()
        .describe(
          "Absolute path to the output .xlsx/.xlsm file (relative paths resolve against the project directory)",
        ),
      sheets: z
        .array(sheetSchema)
        .min(1)
        .describe(
          "Sheets to write. Shape: [{ name, rows: [[cell, ...], ...] }]. Mirrors the excel_parse JSON data model (strip read-only fields, keep name + rows).",
        ),
      maxRows: z.number().int().min(1).optional().describe("Max rows per sheet. Default 1000000."),
      maxCells: z.number().int().min(1).optional().describe("Max cells per sheet. Default 50000000."),
    }),
    async execute(params, ctx) {
      // Relative paths resolve against the primary root; absolute ones may be in any workspace folder, as in read/write
      const outputPath = Workspace.resolveToolPath(Instance.workspace, params.output).filepath

      // Access outside the workspace is blocked by the sandbox, not asked about here
      await ctx.ask({
        permission: "edit",
        checks: [PermissionPolicy.file({ op: "write", path: outputPath, ...PermissionPolicy.scope() })],
        metadata: { filepath: outputPath },
      })

      const workbook: WriteWorkbook = { sheets: params.sheets }

      // As in write / edit: write inside withLock and snapshot before overwriting, otherwise parallel writes to the
      // same path lose updates and the change cannot be undone
      await FileTime.withLock(outputPath, async () => {
        await Snapshot.trackFile(outputPath, ctx.sessionID)
        try {
          await writeExcelWorkbook(outputPath, workbook, {
            maxRowsPerSheet: params.maxRows,
            maxCellsPerSheet: params.maxCells,
          })
        } catch (error) {
          throw fileBusyHint(outputPath, error)
        }
      })

      const totalRows = workbook.sheets.reduce((sum, s) => sum + s.rows.length, 0)
      return {
        title: path.relative(Instance.worktree, outputPath),
        output: `Wrote ${workbook.sheets.length} sheet(s), ${totalRows} row(s) to ${outputPath}`,
        metadata: {
          file: path.basename(outputPath),
          sheets: workbook.sheets.length,
          rows: totalRows,
        },
      }
    },
  },
  // Search terms for deferred loading (see Tool.Info.triggerHint), used for scoring only. As in excel_parse, only
  // domain words; generic verbs such as generate, export, write or output are left out.
  "excel xlsx xlsm 表格 报表 电子表格 工作簿 数据表 sheet 制表",
)

/**
 * On Windows, open() fails with EBUSY/EPERM/EACCES when another program holds the file (usually Excel or WPS has it
 * open). The raw error leaves the model guessing, so it is replaced with a message the model can act on or pass on
 * to the user. The error codes match RECOVERABLE in file/atomic.ts.
 */
function fileBusyHint(filePath: string, error: unknown): unknown {
  const code = (error as { code?: string } | undefined)?.code
  if (code !== "EBUSY" && code !== "EPERM" && code !== "EACCES") return error
  return new Error(
    `Cannot write ${filePath}: the file is locked by another program (usually Excel or WPS has it open). ` +
      `Ask the user to close it, then retry.`,
    { cause: error },
  )
}
