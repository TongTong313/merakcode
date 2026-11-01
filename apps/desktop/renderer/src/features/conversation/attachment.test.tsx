import { createServer } from "node:http"
import { render } from "solid-js/web"
import { afterEach, beforeEach, expect, test, vi } from "vitest"
import { setLocale } from "../../i18n"
import { AttachmentPreview } from "./attachment"
import { fileUrl } from "./suggest"

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

test("a local image is read through the engine and shown", async () => {
  const content = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Zl1sAAAAASUVORK5CYII="
  const requests: string[] = []
  const server = createServer((request, response) => {
    requests.push(request.url ?? "")
    response.writeHead(200, { "content-type": "application/json" })
    response.end(JSON.stringify({ type: "text", content, encoding: "base64", mimeType: "image/png" }))
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const address = server.address()
  if (!address || typeof address === "string") throw new Error("Attachment fixture did not listen")
  location.href = `http://127.0.0.1:${address.port}`
  const host = document.createElement("div")
  document.body.appendChild(host)
  const dispose = render(
    () => (
      <AttachmentPreview
        part={{ mime: "text/plain", filename: "本地 图.png", url: fileUrl("C:/Users/me/本地 图.png") }}
        directory={`/attachment-file-${address.port}`}
      />
    ),
    host,
  )
  cleanup = () => {
    dispose()
    host.remove()
    server.closeAllConnections()
    server.close()
  }
  await vi.waitFor(() =>
    expect(host.querySelector("img")?.getAttribute("src")).toBe(`data:image/png;base64,${content}`),
  )
  expect(new URL(requests[0]!, "http://127.0.0.1").searchParams.get("path")).toBe("C:/Users/me/本地 图.png")
})

test("an image that cannot be read keeps the paperclip", async () => {
  const requests: string[] = []
  const server = createServer((request, response) => {
    requests.push(request.url ?? "")
    response.writeHead(500, { "content-type": "application/json" })
    response.end(JSON.stringify({ data: { message: "not found" } }))
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const address = server.address()
  if (!address || typeof address === "string") throw new Error("Attachment fixture did not listen")
  location.href = `http://127.0.0.1:${address.port}`
  const host = document.createElement("div")
  document.body.appendChild(host)
  const dispose = render(
    () => (
      <AttachmentPreview
        part={{ mime: "image/png", filename: "missing.png", url: fileUrl("C:/Users/me/missing.png") }}
        directory={`/attachment-missing-${address.port}`}
      />
    ),
    host,
  )
  cleanup = () => {
    dispose()
    host.remove()
    server.closeAllConnections()
    server.close()
  }
  await vi.waitFor(() => expect(requests).toHaveLength(1))
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
