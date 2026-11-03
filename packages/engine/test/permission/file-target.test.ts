import { expect, test } from "vitest"
import fs from "node:fs/promises"
import path from "node:path"
import { ReadTool } from "../../src/agent/tools/read"
import { WriteTool } from "../../src/agent/tools/write"
import type { Tool } from "../../src/agent/tools/tool"
import { PermissionNext } from "../../src/agent/permission/next"
import { PermissionPolicy } from "../../src/agent/permission/policy"
import { Session } from "../../src/agent/session"
import { Instance } from "../../src/infra/project/instance"
import { Bus } from "../../src/infra/bus"
import { tmpdir, selectPermissionLevel } from "../fixture/fixture"
import { readySandbox } from "../fixture/sandbox-ready"

test.each(["read", "write", "hardlink", "retarget", "retarget-read", "retarget-read-current"])(
  "autoApprove checks the actual %s target behind a project alias",
  async (kind) => {
    using _isolation = readySandbox()
    await using outside = await tmpdir()
    await using project = await tmpdir({ git: true, config: { lsp: false } })
    await fs.writeFile(path.join(outside.path, ".env"), "SECRET_SENTINEL")
    await fs.writeFile(path.join(outside.path, "plain.txt"), "EXTERNAL_SENTINEL")
    const controlled = path.join(project.path, "controlled")
    await fs.mkdir(controlled)
    await fs.writeFile(path.join(controlled, "plain.txt"), "PROJECT_SENTINEL")
    await fs.symlink(
      kind.startsWith("retarget") ? controlled : outside.path,
      path.join(project.path, "alias"),
      process.platform === "win32" ? "junction" : "dir",
    )
    if (kind === "hardlink") await fs.link(path.join(outside.path, ".env"), path.join(project.path, "source.ts"))
    await Instance.provide({
      directory: project.path,
      fn: async () => {
        const session = await Session.create({})
        await selectPermissionLevel({ sessionID: session.id, permissionLevel: "autoApprove" })
        const shown: PermissionNext.Request[] = []
        const off = Bus.subscribe(PermissionNext.Event.Asked, (event) => {
          shown.push(event.properties)
          void PermissionNext.reply({ requestID: event.properties.id, reply: "reject" })
        })
        let retargeted = false
        let ruleReads = 0
        const retarget = async () => {
          retargeted = true
          await fs.rename(path.join(project.path, "alias"), path.join(project.path, "old-alias"))
          await fs.symlink(
            outside.path,
            path.join(project.path, "alias"),
            process.platform === "win32" ? "junction" : "dir",
          )
        }
        const ctx: Tool.Context = {
          sessionID: session.id,
          messageID: "msg_alias",
          callID: "call_alias",
          agent: "build",
          permissionLevel: "autoApprove",
          abort: new AbortController().signal,
          messages: [],
          ruleset: PermissionPolicy.ruleset("autoApprove"),
          metadata: () => {},
          ask: async (request) => {
            const admission = await PermissionNext.askCurrent({ ...request, sessionID: session.id }, async () => {
              ruleReads++
              if (kind === "retarget-read-current" && ruleReads === 2) {
                await fs.rename(path.join(controlled, "plain.txt"), path.join(controlled, "old.txt"))
                await fs.symlink(path.join(outside.path, "plain.txt"), path.join(controlled, "plain.txt"), "file")
              }
              return PermissionPolicy.ruleset("autoApprove")
            })
            if (kind.startsWith("retarget") && kind !== "retarget-read-current" && !retargeted) {
              await retarget()
            }
            return admission
          },
        }
        try {
          const operation =
            kind === "write" || kind === "retarget"
              ? (await WriteTool.init()).execute(
                  { filePath: path.join(project.path, "alias/new.txt"), content: "CHANGED" },
                  ctx,
                )
              : (await ReadTool.init()).execute(
                  { filePath: path.join(project.path, kind === "hardlink" ? "source.ts" : "alias/plain.txt") },
                  ctx,
                )
          await expect(operation).rejects.toBeInstanceOf(PermissionNext.RejectedError)
          expect(shown).toHaveLength(1)
          expect(await fs.readFile(path.join(outside.path, ".env"), "utf8")).toBe("SECRET_SENTINEL")
          await expect(fs.stat(path.join(outside.path, "new.txt"))).rejects.toMatchObject({ code: "ENOENT" })
        } finally {
          off()
        }
      },
    })
  },
)
