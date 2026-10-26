import { afterEach, describe, expect, test as baseTest } from "vitest"
// ripgrep, tools and Instance.provide setup are slow on Windows, so every test gets 30s
const test = (name: string, fn: () => void | Promise<void>, timeout = 30_000) => baseTest(name, fn, timeout)
import path from "path"
import { Instance } from "@merakcode/engine/project/instance"
import { GrepTool } from "@merakcode/engine/tool/grep"
import { GlobTool } from "@merakcode/engine/tool/glob"
import { WriteTool } from "@merakcode/engine/tool/write"
import { EditTool } from "@merakcode/engine/tool/edit"
import { ReadTool } from "@merakcode/engine/tool/read"
import { MultiEditTool } from "@merakcode/engine/tool/multi_edit"
import { prepareBashCommand } from "@merakcode/engine/tool/bash"
import { ExcelWriteTool } from "@merakcode/engine/tool/excel-write"
import { ExcelParseTool } from "@merakcode/engine/tool/excel-parse"
import { PdfParseTool } from "@merakcode/engine/tool/pdf-parse"
import { LspTool } from "@merakcode/engine/tool/lsp"
import { FileTime } from "@merakcode/engine/file/time"
import { Workspace } from "@merakcode/engine/project/workspace"
import { tmpdir } from "../fixture/fixture"
import { Filesystem } from "@merakcode/util/filesystem"

const ctx = {
  sessionID: "test",
  messageID: "",
  callID: "",
  agent: "build",
  kind: "ask" as const,
  abort: AbortSignal.any([]),
  messages: [],
  ruleset: [],
  metadata: () => {},
  ask: async () => {},
}

describe("tools multi-root", () => {
  afterEach(async () => {
    await Instance.disposeAll().catch(() => undefined)
  })

  test("grep scoped to the second root does not search the first", async () => {
    await using a = await tmpdir({
      git: true,
      init: async (dir) => {
        await Filesystem.write(path.join(dir, "a.txt"), "UNIQUE_TOKEN_ALPHA")
      },
    })
    await using b = await tmpdir({
      git: true,
      init: async (dir) => {
        await Filesystem.write(path.join(dir, "b.txt"), "UNIQUE_TOKEN_BETA")
      },
    })
    await Instance.provide({
      directory: a.path,
      workspace: {
        folders: [
          { name: "alpha", path: a.path },
          { name: "beta", path: b.path },
        ],
      },
      fn: async () => {
        const grep = await GrepTool.init()
        const scoped = await grep.execute({ pattern: "UNIQUE_TOKEN", path: b.path }, ctx)
        expect(scoped.output).toContain("UNIQUE_TOKEN_BETA")
        expect(scoped.output).not.toContain("UNIQUE_TOKEN_ALPHA")

        const all = await grep.execute({ pattern: "UNIQUE_TOKEN" }, ctx)
        expect(all.output).toContain("UNIQUE_TOKEN_ALPHA")
        expect(all.output).toContain("UNIQUE_TOKEN_BETA")

        // The UI and index show `beta/...`; when the model passes that back as path it must scope to the second root
        const byName = await grep.execute({ pattern: "UNIQUE_TOKEN", path: "beta" }, ctx)
        expect(byName.output).toContain("UNIQUE_TOKEN_BETA")
        expect(byName.output).not.toContain("UNIQUE_TOKEN_ALPHA")
      },
    })
  })

  test("glob without path searches all roots", async () => {
    await using a = await tmpdir({
      git: true,
      init: async (dir) => {
        await Filesystem.write(path.join(dir, "only-a.ts"), "export const a = 1")
      },
    })
    await using b = await tmpdir({
      git: true,
      init: async (dir) => {
        await Filesystem.write(path.join(dir, "only-b.ts"), "export const b = 1")
      },
    })
    await Instance.provide({
      directory: a.path,
      workspace: {
        folders: [
          { name: "alpha", path: a.path },
          { name: "beta", path: b.path },
        ],
      },
      fn: async () => {
        const glob = await GlobTool.init()
        const result = await glob.execute({ pattern: "only-*.ts" }, ctx)
        expect(result.output).toContain("only-a.ts")
        expect(result.output).toContain("only-b.ts")
      },
    })
  })

  test("write to the second root does not ask for external_directory", async () => {
    await using a = await tmpdir({ git: true })
    await using b = await tmpdir({ git: true })
    const requests: Array<{ permission: string }> = []
    await Instance.provide({
      directory: a.path,
      workspace: {
        folders: [
          { name: "alpha", path: a.path },
          { name: "beta", path: b.path },
        ],
      },
      fn: async () => {
        const write = await WriteTool.init()
        const testCtx = {
          ...ctx,
          ask: async (req: { permission: string }) => {
            requests.push(req)
          },
        }
        await write.execute({ filePath: path.join(b.path, "out.txt"), content: "hello" }, testCtx)
        expect(await Filesystem.readText(path.join(b.path, "out.txt"))).toBe("hello")
        expect(requests.find((r) => r.permission === "external_directory")).toBeUndefined()
      },
    })
  })

  test("edit and multi_edit in the second root do not ask for external_directory", async () => {
    await using a = await tmpdir({ git: true })
    await using b = await tmpdir({
      git: true,
      init: async (dir) => {
        await Filesystem.write(path.join(dir, "t.txt"), "old")
        await Filesystem.write(path.join(dir, "m.txt"), "aaa")
      },
    })
    const requests: Array<{ permission: string }> = []
    const testCtx = {
      ...ctx,
      ask: async (req: { permission: string }) => {
        requests.push(req)
      },
    }
    await Instance.provide({
      directory: a.path,
      workspace: {
        folders: [
          { name: "alpha", path: a.path },
          { name: "beta", path: b.path },
        ],
      },
      fn: async () => {
        // Match resolveToolPath: on Windows, join and resolve can produce different path keys
        const tPath = path.resolve(b.path, "t.txt")
        const mPath = path.resolve(b.path, "m.txt")
        FileTime.read(testCtx.sessionID, tPath)
        FileTime.read(testCtx.sessionID, mPath)

        const edit = await EditTool.init()
        await edit.execute({ filePath: tPath, oldString: "old", newString: "new" }, testCtx)
        expect(await Filesystem.readText(tPath)).toBe("new")

        const multi = await MultiEditTool.init()
        await multi.execute(
          {
            filePath: mPath,
            edits: [{ oldString: "aaa", newString: "bbb" }],
          },
          testCtx,
        )
        expect(await Filesystem.readText(mPath)).toBe("bbb")
        expect(requests.find((r) => r.permission === "external_directory")).toBeUndefined()
      },
    })
  })

  test("read lists the second root and a bash workdir there does not ask for external_directory", async () => {
    await using a = await tmpdir({ git: true })
    await using b = await tmpdir({
      git: true,
      init: async (dir) => {
        await Filesystem.write(path.join(dir, "listed.txt"), "x")
      },
    })
    const requests: Array<{ permission: string }> = []
    const testCtx = {
      ...ctx,
      ask: async (req: { permission: string }) => {
        requests.push(req)
      },
    }
    await Instance.provide({
      directory: a.path,
      workspace: {
        folders: [
          { name: "alpha", path: a.path },
          { name: "beta", path: b.path },
        ],
      },
      fn: async () => {
        const read = await ReadTool.init()
        const listed = await read.execute({ filePath: b.path }, testCtx)
        expect(listed.output).toContain("listed.txt")

        const prepared = await prepareBashCommand({ command: "echo hi", workdir: b.path, description: "echo" }, testCtx)
        expect(path.resolve(prepared.cwd)).toBe(path.resolve(b.path))
        // prepare does not ask; the sandbox boundary is containsPath, which must include the second root
        expect(Instance.containsPath(prepared.cwd)).toBe(true)
        expect(requests.find((r) => r.permission === "external_directory")).toBeUndefined()
      },
    })
  })

  test("excel_write/parse, pdf_parse and lsp paths in the second root do not ask for external_directory", async () => {
    await using a = await tmpdir({ git: true, config: { lsp: false } })
    await using b = await tmpdir({ git: true })
    const requests: Array<{ permission: string }> = []
    const testCtx = {
      ...ctx,
      ask: async (req: { permission: string }) => {
        requests.push(req)
      },
    }
    await Instance.provide({
      directory: a.path,
      workspace: {
        folders: [
          { name: "alpha", path: a.path },
          { name: "beta", path: b.path },
        ],
      },
      fn: async () => {
        const xlsx = path.resolve(b.path, "sheet.xlsx")
        const excelWrite = await ExcelWriteTool.init()
        await excelWrite.execute(
          {
            output: xlsx,
            sheets: [
              {
                name: "S1",
                rows: [
                  ["k", "v"],
                  ["1", "2"],
                ],
              },
            ],
          },
          testCtx,
        )
        expect(await Filesystem.isFile(xlsx)).toBe(true)

        const excelParse = await ExcelParseTool.init()
        const parsed = await excelParse.execute({ filePath: xlsx }, testCtx)
        expect(parsed.output).toContain("S1")

        // Minimal valid PDF: only the path sandbox matters here, not a successful render
        const pdfPath = path.resolve(b.path, "tiny.pdf")
        await Filesystem.write(
          pdfPath,
          `%PDF-1.4
1 0 obj<< /Type /Catalog /Pages 2 0 R >>endobj
2 0 obj<< /Type /Pages /Kids [] /Count 0 >>endobj
trailer<< /Root 1 0 R >>
%%EOF
`,
        )
        const pdf = await PdfParseTool.init()
        try {
          await pdf.execute({ filePath: pdfPath }, testCtx)
        } catch {
          // Parse failures (no pages, no canvas) are fine; it must just not be treated as external_directory
        }

        const src = path.resolve(b.path, "x.ts")
        await Filesystem.write(src, "export const x = 1\n")
        expect(Workspace.resolveToolPath(Instance.workspace, src).folder?.name).toBe("beta")
        const lsp = await LspTool.init()
        try {
          // Fails fast without a language server; the second-root path must just count as inside the workspace
          await lsp.execute({ operation: "hover", filePath: src, line: 1, character: 1 }, testCtx)
        } catch {
          // No LSP server or an empty hover are both fine
        }

        expect(requests.find((r) => r.permission === "external_directory")).toBeUndefined()
      },
    })
  })
})
