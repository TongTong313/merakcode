import { expect, test } from "vitest"
import path from "path"
import { PDFDocument, StandardFonts, type PDFFont, type PDFPage } from "pdf-lib"
import { PdfParseTool } from "@merakcode/engine/agent/tools/pdf-parse"
import { prepareCanvasForPdfjs } from "@merakcode/engine/infra/document/pdf/canvas-native"
import { Instance } from "@merakcode/engine/infra/project/instance"
import { Filesystem } from "@merakcode/util/filesystem"
import { tmpdir } from "../fixture/fixture"

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

async function pdf(draw: (page: PDFPage, font: PDFFont) => void) {
  const doc = await PDFDocument.create()
  const page = doc.addPage([400, 200])
  draw(page, await doc.embedFont(StandardFonts.Helvetica))
  return Buffer.from(await doc.save())
}

async function families() {
  const prepared = await prepareCanvasForPdfjs()
  if (!prepared.ok) throw new Error(prepared.reason)
  return prepared.canvas.GlobalFonts.families.length
}

async function parse(name: string, content: Buffer) {
  await using tmp = await tmpdir({ init: (dir) => Filesystem.write(path.join(dir, name), content) })
  return await Instance.provide({
    directory: tmp.path,
    fn: async () => (await PdfParseTool.init()).execute({ filePath: path.join(tmp.path, name) }, ctx),
  })
}

// Font loading is process-wide, so the text-only test must run before the one that renders
test("reading the text of a PDF leaves the system fonts unloaded", async () => {
  const result = await parse(
    "text.pdf",
    await pdf((page, font) =>
      page.drawText("Quarterly revenue grew twelve percent", { x: 20, y: 100, size: 12, font }),
    ),
  )

  expect(result.output).toContain("Quarterly revenue grew twelve percent")
  expect(result.metadata.renderedPages).toEqual([])
  expect(await families()).toBe(0)
  expect(process.env.DISABLE_SYSTEM_FONTS_LOAD).toBeUndefined()
})

test("rendering a page loads the system fonts before drawing it", async () => {
  // More than 20 path operations make a table page, which is rendered to an image
  const result = await parse(
    "table.pdf",
    await pdf((page, font) => {
      page.drawText("Region totals", { x: 20, y: 180, size: 12, font })
      for (let i = 0; i < 25; i++) page.drawLine({ start: { x: 20, y: 10 + i * 6 }, end: { x: 380, y: 10 + i * 6 } })
    }),
  )

  expect(result.metadata.renderedPages).toEqual([1])
  expect(await families()).toBeGreaterThan(0)
})
