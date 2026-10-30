import { expect, test } from "vitest"
import path from "path"
import { PDFDocument, StandardFonts, rgb } from "pdf-lib"
import { createCanvas, loadImage } from "@napi-rs/canvas"
import { PdfParseTool } from "@merakcode/engine/agent/tools/pdf-parse"
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

/**
 * One page with a light gray image and large black text in standard Helvetica without embedded glyphs, which only
 * renders with pdfjs's bundled font data
 */
async function mixedPage() {
  const pdf = await PDFDocument.create()
  const page = pdf.addPage([400, 200])
  const background = createCanvas(40, 40)
  const paint = background.getContext("2d")
  paint.fillStyle = "#dddddd"
  paint.fillRect(0, 0, 40, 40)
  page.drawImage(await pdf.embedPng(await background.encode("png")), { x: 300, y: 120, width: 80, height: 60 })
  const font = await pdf.embedFont(StandardFonts.Helvetica)
  page.drawText("Hello PDF", { x: 20, y: 100, size: 48, font, color: rgb(0, 0, 0) })
  // At least 100 characters of body text make this a mixed page; image pages with less text count as image-only
  page.drawText("Revenue grew twelve percent this quarter while costs stayed flat in every region.", {
    x: 20,
    y: 40,
    size: 8,
    font,
  })
  page.drawText("The board approved the budget for the next fiscal year.", { x: 20, y: 28, size: 8, font })
  return pdf.save()
}

async function darkPixels(url: string) {
  const image = await loadImage(Buffer.from(url.slice(url.indexOf(",") + 1), "base64"))
  const canvas = createCanvas(image.width, image.height)
  const paint = canvas.getContext("2d")
  paint.drawImage(image, 0, 0)
  const data = paint.getImageData(0, 0, image.width, image.height).data
  return Array.from({ length: data.length / 4 }, (_, i) => i * 4).filter(
    (i) => data[i + 3]! > 0 && data[i]! < 80 && data[i + 1]! < 80 && data[i + 2]! < 80,
  ).length
}

test("a mixed text and image page extracts the text and renders it in the page image", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => Filesystem.write(path.join(dir, "mixed.pdf"), Buffer.from(await mixedPage())),
  })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const tool = await PdfParseTool.init()
      const result = await tool.execute({ filePath: path.join(tmp.path, "mixed.pdf") }, ctx)

      expect(result.output).toContain("Hello PDF")
      expect(result.attachments).toHaveLength(1)
      // 48pt text at 2x scale yields over ten thousand dark pixels; without the text only the light gray image remains
      expect(await darkPixels(result.attachments![0]!.url)).toBeGreaterThan(2000)
    },
  })
})
