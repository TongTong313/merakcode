import { BlobReader, TextWriter, ZipReader } from "@zip.js/zip.js"
import { readFile } from "node:fs/promises"
import path from "node:path"
import metadata from "../package.json" with { type: "json" }
import { test, expect } from "./fixture"

test("about shows both versions and saves the engine diagnostic archive", async ({ kit }) => {
  const archive = path.join(kit.root, "diagnostics.zip")
  // Only the native file chooser is supplied; the engine, transport, archive and file write are real.
  await kit.app.evaluate(({ dialog }, filePath) => {
    dialog.showSaveDialog = async () => ({ canceled: false, filePath })
  }, archive)
  await kit.settings(/^(关于与更新|About & updates)$/)
  await expect(kit.page.getByText(`引擎版本 ${metadata.version}`, { exact: true })).toBeVisible()
  await expect(kit.page.getByText(new RegExp(`^版本 ${metadata.version.replaceAll(".", "\\.")}`))).toBeVisible()
  await kit.page.getByRole("button", { name: "导出诊断包", exact: true }).click()
  await expect
    .poll(() =>
      readFile(archive).then(
        (body) => body.subarray(0, 2).toString(),
        () => "",
      ),
    )
    .toBe("PK")
  const reader = new ZipReader(new BlobReader(new Blob([await readFile(archive)])))
  try {
    const entries = await reader.getEntries()
    const versions = entries.find((entry) => entry.filename === "versions.json")!
    if (versions.directory) throw new Error("Version entry is a directory")
    expect(JSON.parse(await versions.getData!(new TextWriter()))).toMatchObject({
      merak: metadata.version,
      desktop: metadata.version,
    })
    expect(entries.some((entry) => entry.filename === "engine.json")).toBe(true)
  } finally {
    await reader.close()
  }
})

test("diagnostic export cancellation is quiet and write failures show a catalog error", async ({ kit }) => {
  await kit.app.evaluate(({ dialog }) => {
    dialog.showSaveDialog = async () => ({ canceled: true, filePath: "" })
  })
  await kit.settings(/^(关于与更新|About & updates)$/)
  const button = kit.page.getByRole("button", { name: "导出诊断包", exact: true })
  await button.click()
  await expect(button).toBeEnabled()
  await expect(kit.page.getByText("诊断包已保存", { exact: true })).toHaveCount(0)
  await kit.app.evaluate(({ dialog }, filePath) => {
    dialog.showSaveDialog = async () => ({ canceled: false, filePath })
  }, kit.root)
  await button.click()
  const status = kit.page.getByRole("status")
  await expect(status).toContainText("诊断包生成失败")
  await expect(status).toContainText("检查日志、存储连接和输出路径后重试。")
  await expect(status).toContainText("MRK-1004")
})
