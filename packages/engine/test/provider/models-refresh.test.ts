import { expect, test } from "vitest"
import fs from "fs/promises"
import { createServer } from "http"
import type { AddressInfo } from "net"
import path from "path"
import { pathToFileURL } from "url"
import { evaluate, tmpdir } from "../fixture/fixture"
import { Process } from "@merakcode/util/process"

// The model list refreshes in the background. A failed cache write (full disk, path taken, no permission) must only
// be logged; an unhandled rejection would exit the whole process on Node.
test("background refresh does not exit the process when the model cache cannot be written", async () => {
  await using tmp = await tmpdir()
  // A directory occupies the cache file path, so the write always fails.
  await fs.mkdir(path.join(tmp.path, "cache", "merakcode", "models.json"), { recursive: true })
  await fs.writeFile(path.join(tmp.path, "cache", "merakcode", "version"), "21")
  const server = createServer((_req, res) => res.end("{}"))
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  try {
    const source = pathToFileURL(path.resolve(import.meta.dirname, "../../src/provider/models.ts")).href
    const child = Process.spawn(
      evaluate(
        `const { ModelsDev } = await import(${JSON.stringify(source)}); await ModelsDev.refresh(); await new Promise((r) => setTimeout(r, 200)); console.log("alive")`,
      ),
      {
        env: {
          ...process.env,
          XDG_CACHE_HOME: path.join(tmp.path, "cache"),
          MERAKCODE_MODELS_URL: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
          MERAKCODE_DISABLE_MODELS_FETCH: "",
        },
        stdout: "pipe",
        stderr: "pipe",
      },
    )
    const [code, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ])
    expect(code, stderr).toBe(0)
    expect(stdout.trim()).toBe("alive")
  } finally {
    server.close()
  }
})
