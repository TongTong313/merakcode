import { expect, test } from "vitest"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { Process } from "@merakcode/util/process"

test.skipIf(process.platform !== "win32")(
  "sandbox verification never initializes a missing Windows account",
  async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "sandbox-verify-"))
    try {
      const repo = path.resolve(import.meta.dirname, "..")
      const result = await Process.run(
        [
          process.execPath,
          "--import",
          pathToFileURL(path.join(repo, "script/node/register.mjs")).href,
          path.join(repo, "packages/engine/script/sandbox-ci.ts"),
          "verify",
        ],
        { env: { ...process.env, MERAKCODE_HOME: root }, nothrow: true, timeout: 10000 },
      )
      expect(result.exitCode).toBe(1)
      expect(result.stderr.toString()).toContain("Run merak sandbox setup once")
      await expect(fs.stat(path.join(root, "data/sandbox/state.json"))).rejects.toMatchObject({ code: "ENOENT" })
    } finally {
      await fs.rm(root, { recursive: true, force: true })
    }
  },
)
