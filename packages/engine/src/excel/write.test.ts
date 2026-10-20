import { afterEach, describe, expect, test } from "vitest"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { BlobReader, ZipReader } from "@zip.js/zip.js"
import { Filesystem } from "@merakcode/util/filesystem"
import { normalizeEntry, readEntry, type ZipEntry } from "../util/xml"
import { parseExcelWorkbook } from "./parse"
import { writeExcelWorkbook, type WriteWorkbook } from "./write"

/**
 * Package structure tests for the Excel writer.
 *
 * Excel/WPS resolves parts through the OPC relationship graph and drops parts without a relationship as orphans. If
 * xl/sharedStrings.xml is missing from xl/_rels/workbook.xml.rels, every t="s" text cell renders blank while numbers
 * (inlined in <v>) still show.
 *
 * The read side reads xl/sharedStrings.xml by fixed path, not through the graph, so excel_parse round trips and
 * openpyxl cannot detect this; only real Excel does. The tests therefore assert on the relationship graph itself
 * rather than on reading the content back, which passes either way.
 */

const REL_SHARED_STRINGS = "http://schemas.openxmlformats.org/officeDocument/2006/relationships/sharedStrings"
const REL_STYLES = "http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles"

const dirs: string[] = []

async function tempDir() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "excel-write-test-"))
  dirs.push(dir)
  return dir
}

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })))
})

/** Unpacks an xlsx into part path -> text content, for checking the package structure directly */
async function readParts(filePath: string) {
  const zip = new ZipReader(new BlobReader(new Blob([await Filesystem.readBytes(filePath)])))
  try {
    const parts = new Map<string, string>()
    for (const entry of await zip.getEntries()) {
      if (entry.filename.endsWith("/")) continue
      parts.set(normalizeEntry(entry.filename), await readEntry(entry as ZipEntry))
    }
    return parts
  } finally {
    await zip.close()
  }
}

/** Reads relationship type -> target part path (normalized to the package root) from the workbook relationships */
function relationships(relsXml: string) {
  const result = new Map<string, string>()
  for (const match of relsXml.matchAll(/<Relationship\b[^>]*\/?>/g)) {
    const type = /\bType="([^"]*)"/.exec(match[0])?.[1]
    const target = /\bTarget="([^"]*)"/.exec(match[0])?.[1]
    // Target is relative to xl/; an absolute path (starting with /) is relative to the package root
    if (type && target) result.set(type, target.startsWith("/") ? normalizeEntry(target) : `xl/${target}`)
  }
  return result
}

async function writeSample(name = "book.xlsx") {
  const file = path.join(await tempDir(), name)
  await writeExcelWorkbook(file, sample)
  return file
}

const sample: WriteWorkbook = {
  sheets: [
    {
      name: "Sheet1",
      rows: [
        ["序号", "名称", "数量"],
        [1, "苹果", 50],
        [2, "牛奶", 30],
      ],
    },
  ],
}

describe("writeExcelWorkbook package structure", () => {
  test("registers the shared string table in the workbook relationships", async () => {
    const parts = await readParts(await writeSample())
    // The part existing is not enough; the relationship is what Excel needs
    expect(parts.has("xl/sharedStrings.xml")).toBe(true)

    const rels = relationships(parts.get("xl/_rels/workbook.xml.rels") ?? "")
    expect(rels.get(REL_SHARED_STRINGS)).toBe("xl/sharedStrings.xml")
  })

  test("registers the stylesheet in the workbook relationships", async () => {
    const parts = await readParts(await writeSample())
    expect(parts.has("xl/styles.xml")).toBe(true)

    const rels = relationships(parts.get("xl/_rels/workbook.xml.rels") ?? "")
    expect(rels.get(REL_STYLES)).toBe("xl/styles.xml")
  })

  test("every relationship target exists in the package", async () => {
    const parts = await readParts(await writeSample())
    const rels = relationships(parts.get("xl/_rels/workbook.xml.rels") ?? "")

    expect(rels.size).toBeGreaterThan(0)
    for (const [type, target] of rels) {
      expect(parts.has(target), `关系 ${type} 指向的部件不存在: ${target}`).toBe(true)
    }
  })

  test("includes the font, fill and border tables referenced by cellXfs so Excel does not ask to repair", async () => {
    const parts = await readParts(await writeSample())
    const styles = parts.get("xl/styles.xml") ?? ""

    expect(styles).toContain("<fonts")
    expect(styles).toContain("<fills")
    expect(styles).toContain("<borders")
  })
})

describe("writeExcelWorkbook round trip", () => {
  test("reads the written workbook back unchanged, keeping CJK text and number types", async () => {
    const parsed = await parseExcelWorkbook(await writeSample("roundtrip.xlsx"))

    expect(parsed.sheets).toHaveLength(1)
    expect(parsed.sheets[0]!.name).toBe("Sheet1")
    expect(parsed.sheets[0]!.rows.map((row) => row.cells)).toEqual([
      ["序号", "名称", "数量"],
      [1, "苹果", 50],
      [2, "牛奶", 30],
    ])
  })
})
