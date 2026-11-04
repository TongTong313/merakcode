import { expect, test } from "vitest"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { WindowsSandbox } from "../../src/infra/sandbox/windows"
import { SandboxPolicy } from "../../src/agent/permission/sandbox-policy"

test.skipIf(process.platform !== "win32" || !WindowsSandbox.compiler())(
  "Windows reports a failed sandbox when its saved account cannot start a process",
  async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "sandbox-status-"))
    try {
      await fs.writeFile(path.join(root, "state.json"), JSON.stringify({ sid: "S-1-5-21-invalid", granted: [] }))
      await fs.writeFile(path.join(root, "password.bin"), "invalid-password")
      const backend = WindowsSandbox.create(SandboxPolicy.base(os.homedir()), { root })
      const status = await backend.status()
      expect(status.status).toBe("failed")
      expect(status.reason).not.toContain("\uFFFD")
      expect((await backend.status()).status).toBe("failed")
    } finally {
      await fs.rm(root, { recursive: true, force: true })
    }
  },
  20000,
)
