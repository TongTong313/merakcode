import { expect, test } from "vitest"
import path from "path"
import { Filesystem } from "@merakcode/util/filesystem"
import { Instance } from "@merakcode/engine/project/instance"
import { Server } from "@merakcode/engine/server/server"
import { tmpdir } from "../fixture/fixture"

// The editor and review "revert here" read a file, change part of it and write it back. Reads must return the exact
// bytes on disk (no trimmed whitespace or trailing newline) with a checksum, so the write can detect conflicts.

const request = (dir: string, method: string, route: string, body?: unknown) =>
  Server.App().request(
    `http://localhost${route}${route.includes("?") ? "&" : "?"}directory=${encodeURIComponent(dir)}`,
    {
      method,
      headers: body ? { "content-type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    },
  )

test("read returns the exact file content (trailing newlines and CRLF kept) with a checksum; writing it back is a no-op", async () => {
  const original = "  indented\r\nsecond line\r\n\r\n"
  await using tmp = await tmpdir({ init: (dir) => Filesystem.write(path.join(dir, "a.txt"), original) })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const read = (await (await request(tmp.path, "GET", "/file/content?path=a.txt")).json()) as {
        content: string
        checksum?: string
      }
      expect(read.content).toBe(original)
      expect(read.checksum).toMatch(/^[0-9a-f]{40}$/)
      const write = await request(tmp.path, "PUT", "/file/content", {
        path: "a.txt",
        content: read.content,
        checksum: read.checksum,
      })
      expect(write.status).toBe(200)
      expect(await Filesystem.readText(path.join(tmp.path, "a.txt"))).toBe(original)
    },
  })
})

test("write with a stale checksum returns 409 and does not overwrite a file changed after the read", async () => {
  await using tmp = await tmpdir({ init: (dir) => Filesystem.write(path.join(dir, "a.txt"), "v1\n") })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const read = (await (await request(tmp.path, "GET", "/file/content?path=a.txt")).json()) as { checksum: string }
      await Filesystem.write(path.join(tmp.path, "a.txt"), "v2 by agent\n")
      const write = await request(tmp.path, "PUT", "/file/content", {
        path: "a.txt",
        content: "v1 edited by user\n",
        checksum: read.checksum,
      })
      expect(write.status).toBe(409)
      expect(await Filesystem.readText(path.join(tmp.path, "a.txt"))).toBe("v2 by agent\n")
    },
  })
})
