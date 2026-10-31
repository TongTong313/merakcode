import { expect, test } from "vitest"
import { execFile } from "node:child_process"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import net from "node:net"
import os from "node:os"
import path from "node:path"
import { promisify } from "node:util"
import { Sandbox } from "../../../src/infra/sandbox/index"
import { SandboxPolicy } from "../../../src/agent/permission/sandbox-policy"
import { externalTarget } from "./target"

test("an explicitly supplied external endpoint is reachable only outside the sandbox", async () => {
  const target = externalTarget(process.env.MERAKCODE_SANDBOX_EXTERNAL_TARGET)
  const backend = Sandbox.backend(SandboxPolicy.base(os.homedir()))
  const status = await backend.status()
  expect(status.status, status.reason).toBe("on")
  expect(status.degraded ?? []).not.toContain("network-not-enforced")
  // Fail on an unreachable control target: that is not evidence of isolation.
  await new Promise<void>((resolve, reject) => {
    const socket = net.connect(target.port, target.hostname)
    socket.setTimeout(10_000, () => socket.destroy(new Error("External control target timed out")))
    socket.on("connect", () => {
      socket.destroy()
      resolve()
    })
    socket.on("error", reject)
  })
  const root = await mkdtemp(path.join(os.homedir(), "merakcode-external-conformance-"))
  const sandbox = Sandbox.create(backend)
  try {
    const script = path.join(root, "connect.cjs")
    await writeFile(
      script,
      `const s = require("net").connect(${target.port}, ${JSON.stringify(target.hostname)}); s.setTimeout(10000, () => { console.log("blocked:timeout"); s.destroy() }); s.on("connect", () => { console.log("connected"); s.destroy() }); s.on("error", e => console.log("blocked:" + e.code))`,
    )
    const prepared = await sandbox.prepare({
      command: `"${process.execPath}" "${script}"`,
      shell: process.platform === "win32" ? (process.env.ComSpec ?? "cmd.exe") : "/bin/sh",
      cwd: root,
      env: process.env,
      policy: SandboxPolicy.build({ workspace: [root], home: os.homedir(), tmp: root }),
      tmp: root,
      ask: async () => false,
    })
    try {
      const result = await promisify(execFile)(prepared.file, prepared.args, {
        cwd: root,
        env: prepared.env,
        timeout: 20_000,
        windowsHide: true,
      })
      expect(result.stdout).toMatch(/^blocked:/m)
      expect(result.stdout).not.toContain("connected")
    } finally {
      prepared.finish("", 0)
    }
  } finally {
    await sandbox.close()
    await rm(root, { recursive: true, force: true })
  }
})
