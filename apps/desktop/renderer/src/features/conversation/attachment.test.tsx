import { writeFile } from "node:fs/promises"
import path from "node:path"
import { engineFixture } from "../../test/engine"
import { client } from "../../state/client"
import { render } from "solid-js/web"
import { afterAll, beforeAll, afterEach, beforeEach, expect, test, vi } from "vitest"
import { setLocale } from "../../i18n"
import { AttachmentPreview } from "./attachment"
import { fileUrl } from "./suggest"

let engine: Awaited<ReturnType<typeof engineFixture>>
beforeAll(async () => {
  engine = await engineFixture()
  location.href = engine.url
})
afterAll(async () => {
  try {
    await (await client()).close()
  } finally {
    await engine.close()
  }
})
let cleanup = () => {}
beforeEach(() => setLocale("zh"))
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

const png =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Zl1sAAAAASUVORK5CYII="

test("an image attachment shows a thumbnail", () => {
  const host = document.createElement("div")
  document.body.appendChild(host)
  const dispose = render(
    () => (
      <AttachmentPreview part={{ mime: "image/png", filename: "shot.png", url: png }} directory="/attachment-test" />
    ),
    host,
  )
  cleanup = () => {
    dispose()
    host.remove()
  }
  expect(host.querySelector("img")?.getAttribute("src")).toBe(png)
  expect(host.querySelector('[aria-label="查看图片 shot.png"]')).not.toBeNull()
})

test("clicking a thumbnail opens the full image and closes it", async () => {
  const host = document.createElement("div")
  document.body.appendChild(host)
  const dispose = render(
    () => (
      <AttachmentPreview part={{ mime: "image/png", filename: "shot.png", url: png }} directory="/attachment-test" />
    ),
    host,
  )
  cleanup = () => {
    dispose()
    host.remove()
  }
  host.querySelector<HTMLButtonElement>('[aria-label="查看图片 shot.png"]')!.click()
  await vi.waitFor(() => expect(document.querySelector('[role="dialog"]')).not.toBeNull())
  const dialog = document.querySelector("[role=dialog]")!
  expect(dialog.querySelector("img")?.getAttribute("src")).toBe(png)
  dialog.querySelector<HTMLButtonElement>(".dialog-foot button")!.click()
  await vi.waitFor(() => expect(document.querySelector("[role=dialog]")).toBeNull())
})

test("a local image is read through the real engine and shown", async () => {
  const content = png.split(",")[1]!
  const file = path.join(engine.project, "local image.png")
  await writeFile(file, Buffer.from(content, "base64"))
  const host = document.createElement("div")
  document.body.appendChild(host)
  const dispose = render(
    () => (
      <AttachmentPreview
        part={{ mime: "text/plain", filename: "local image.png", url: fileUrl(file) }}
        directory={engine.project}
      />
    ),
    host,
  )
  cleanup = () => {
    dispose()
    host.remove()
  }
  await expect.poll(() => host.querySelector("img")?.getAttribute("src"), { timeout: 5000 }).toBe(png)
})

test("an image that cannot be read keeps the paperclip", async () => {
  const file = path.join(engine.project, "missing.png")
  const host = document.createElement("div")
  document.body.appendChild(host)
  const dispose = render(
    () => (
      <AttachmentPreview
        part={{ mime: "image/png", filename: "missing.png", url: fileUrl(file) }}
        directory={engine.project}
      />
    ),
    host,
  )
  cleanup = () => {
    dispose()
    host.remove()
  }
  await expect((await client()).file.read({ directory: engine.project, path: file })).rejects.toThrow("MRK-5001")
  expect(host.querySelector("img")).toBeNull()
  expect(host.querySelector("svg")).not.toBeNull()
  expect(host.textContent).toContain("missing.png")
  expect(host.querySelector("button")).toBeNull()
})

test("a non-image attachment keeps the paperclip", () => {
  const host = document.createElement("div")
  document.body.appendChild(host)
  const dispose = render(
    () => (
      <AttachmentPreview
        part={{ mime: "text/plain", filename: "notes.txt", url: fileUrl("C:/Users/me/notes.txt") }}
        directory="/attachment-text"
      />
    ),
    host,
  )
  cleanup = () => {
    dispose()
    host.remove()
  }
  expect(host.querySelector("img")).toBeNull()
  expect(host.querySelector('[aria-label^="查看图片"]')).toBeNull()
  expect(host.querySelector("svg")).not.toBeNull()
  expect(host.textContent).toContain("notes.txt")
  expect(host.querySelector("button")).toBeNull()
})
