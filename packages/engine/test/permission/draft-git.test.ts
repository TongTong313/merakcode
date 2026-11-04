import { execFileSync } from "node:child_process"
import { expect, test } from "vitest"
import { Instance } from "../../src/infra/project/instance"
import { Session } from "../../src/agent/session"
import { Loop } from "../../src/agent/loop"
import { PermissionNext } from "../../src/agent/permission/next"
import { PermissionPolicy } from "../../src/agent/permission/policy"
import { BashTool } from "../../src/agent/tools/bash"
import { prepareBashCommand } from "../../src/agent/tools/bash"
import type { Tool } from "../../src/agent/tools/tool"
import type { PermissionLevel } from "../../src/agent/permission/level"
import { TaskScope } from "../../src/agent/permission/scope"
import { Bus } from "../../src/infra/bus"
import { decideExternal } from "../../src/agent/external/runtime"
import { readySandbox } from "../fixture/sandbox-ready"
import { Process } from "@merakcode/util/process"
import fs from "node:fs/promises"
import path from "node:path"
import { tmpdir, selectPermissionLevel } from "../fixture/fixture"

async function draftContext(permissionLevel: PermissionLevel.Value): Promise<Tool.Context> {
  const session = await Session.create({})
  await selectPermissionLevel({ sessionID: session.id, permissionLevel })
  await Loop.prompt({
    sessionID: session.id,
    noReply: true,
    model: { providerID: "openai", modelID: "gpt-4" },
    parts: [{ type: "text", text: "Draft only. Do not modify the project." }],
  })
  return {
    sessionID: session.id,
    messageID: "",
    callID: "draft-git",
    agent: "build",
    permissionLevel,
    abort: new AbortController().signal,
    messages: [],
    ruleset: PermissionPolicy.ruleset(permissionLevel),
    metadata: () => {},
    ask: (input) =>
      PermissionNext.askCurrent({ ...input, sessionID: session.id }, async () =>
        PermissionPolicy.ruleset(permissionLevel),
      ),
  }
}

test("a draft-only task can inspect ordinary Git history without changing the project", async () => {
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const ctx = await draftContext("fullTakeover")
      const tool = await BashTool.init()
      const result = await tool.execute({ command: "git log --oneline -1", description: "Inspect recent history" }, ctx)
      expect(result.metadata.exit, result.output).toBe(0)
      expect(result.output).toContain("root commit")
    },
  })
})

test.each(["ask", "autoApprove", "fullTakeover"] as const)(
  "Git history follows %s with and without isolation",
  async (level) => {
    for (const ready of [true, false]) {
      using _isolation = readySandbox()
      if (!ready) process.env.MERAKCODE_SANDBOX_MODE = "off"
      await using tmp = await tmpdir({ git: true })
      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          const ctx = await draftContext(level)
          const shown: PermissionNext.Request[] = []
          const replies: Promise<void>[] = []
          const unsubscribe = Bus.subscribe(PermissionNext.Event.Asked, ({ properties }) => {
            shown.push(properties)
            replies.push(PermissionNext.reply({ requestID: properties.id, reply: "once" }))
          })
          try {
            for (let i = 0; i < 2; i++)
              await prepareBashCommand({ command: "git log --oneline -1", description: "Inspect history" }, ctx)
            await Promise.all(replies)
            expect(shown).toHaveLength(level === "fullTakeover" || (level === "autoApprove" && ready) ? 0 : 2)
          } finally {
            unsubscribe()
          }
        },
      })
    }
  },
)

test.each(["status --short", "diff"])("draft-only Git %s cannot run a configured clean filter", async (command) => {
  await using tmp = await tmpdir({ git: true })
  const effect = path.join(tmp.path, "effect")
  await fs.writeFile(path.join(tmp.path, "tracked.txt"), "before\n")
  await Process.run(["git", "add", "tracked.txt"], { cwd: tmp.path })
  await Process.run(["git", "commit", "-m", "Track file"], { cwd: tmp.path })
  await fs.writeFile(path.join(tmp.path, ".gitattributes"), "tracked.txt filter=evil\n")
  await fs.writeFile(
    path.join(tmp.path, "filter.cjs"),
    `require('fs').writeFileSync(${JSON.stringify(effect)}, 'ran'); process.stdin.pipe(process.stdout)`,
  )
  await Process.run(["git", "config", "filter.evil.clean", "node filter.cjs"], { cwd: tmp.path })
  await fs.writeFile(path.join(tmp.path, "tracked.txt"), "after!\n")
  await Process.run(["git", ...command.split(" ")], { cwd: tmp.path })
  expect(await fs.readFile(effect, "utf8")).toBe("ran")
  await fs.rm(effect)
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const ctx = await draftContext("fullTakeover")
      await expect(
        (await BashTool.init()).execute({ command: `git ${command}`, description: "Inspect files" }, ctx),
      ).rejects.toBeInstanceOf(TaskScope.DeniedError)
      await expect(fs.stat(effect)).rejects.toMatchObject({ code: "ENOENT" })
      const history = await (
        await BashTool.init()
      ).execute({ command: "git log -1 -p", description: "Inspect commit" }, ctx)
      expect(history.metadata.exit, history.output).toBe(0)
      await expect(fs.stat(effect)).rejects.toMatchObject({ code: "ENOENT" })
    },
  })
})

test("draft-only git log cannot execute a configured signature program through format.pretty", async () => {
  await using tmp = await tmpdir({ git: true })
  const git = (args: string[], input?: string) =>
    execFileSync("git", args, { cwd: tmp.path, encoding: "utf8", input, windowsHide: true }).trim()
  const marker = path.join(tmp.path, "effect")
  const program = path.join(tmp.path, process.platform === "win32" ? "signer.cmd" : "signer.sh")
  await fs.writeFile(
    program,
    process.platform === "win32"
      ? "@echo off\r\necho ran > effect\r\nexit /b 1\r\n"
      : "#!/bin/sh\necho ran > effect\nexit 1\n",
    { mode: 0o755 },
  )
  const parent = git(["rev-parse", "HEAD"])
  const tree = git(["rev-parse", "HEAD^{tree}"])
  const commit = `tree ${tree}\nparent ${parent}\nauthor Test <test@example.com> 1700000000 +0000\ncommitter Test <test@example.com> 1700000000 +0000\ngpgsig -----BEGIN PGP SIGNATURE-----\n fake\n -----END PGP SIGNATURE-----\n\nSigned fixture\n`
  const id = git(["hash-object", "-t", "commit", "-w", "--stdin"], commit)
  git(["update-ref", "HEAD", id])
  git(["config", "format.pretty", "%G?"])
  git(["config", "pretty.medium", "%G?"])
  git(["config", "gpg.program", program.replaceAll("\\", "/")])
  git(["-c", "log.showSignature=false", "log", "-1"])
  expect(await fs.readFile(marker, "utf8")).toContain("ran")
  await fs.rm(marker)
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const ctx = await draftContext("fullTakeover")
      const result = await (
        await BashTool.init()
      ).execute({ command: "git log -1", description: "Inspect history" }, ctx)
      expect(result.metadata.exit, result.output).toBe(0)
      await expect(fs.stat(marker)).rejects.toMatchObject({ code: "ENOENT" })
    },
  })
})

test("draft-only git log cannot execute a submodule external diff", async () => {
  await using tmp = await tmpdir({ git: true })
  const git = (cwd: string, args: string[]) =>
    execFileSync("git", args, { cwd, encoding: "utf8", windowsHide: true }).trim()
  const sub = path.join(tmp.path, "sub")
  const marker = path.join(tmp.path, "effect")
  await fs.mkdir(sub)
  git(sub, ["init"])
  git(sub, ["config", "user.name", "Test"])
  git(sub, ["config", "user.email", "test@example.com"])
  await fs.writeFile(path.join(sub, "tracked.txt"), "before\n")
  git(sub, ["add", "tracked.txt"])
  git(sub, ["commit", "-m", "Before"])
  await fs.writeFile(path.join(tmp.path, ".gitmodules"), '[submodule "sub"]\n path = sub\n url = ./sub\n')
  git(tmp.path, ["add", "sub", ".gitmodules"])
  git(tmp.path, ["commit", "-m", "Submodule before"])
  await fs.writeFile(path.join(sub, "tracked.txt"), "after\n")
  git(sub, ["add", "tracked.txt"])
  git(sub, ["commit", "-m", "After"])
  git(tmp.path, ["add", "sub"])
  git(tmp.path, ["commit", "-m", "Submodule after"])
  const program = path.join(sub, "diff.cjs")
  await fs.writeFile(program, `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'ran')`)
  git(sub, ["config", "diff.external", `node "${program.replaceAll("\\", "/")}"`])
  git(tmp.path, ["config", "diff.submodule", "diff"])
  git(tmp.path, ["log", "-1", "-p", "--no-ext-diff", "--no-textconv"])
  expect(await fs.readFile(marker, "utf8")).toBe("ran")
  await fs.rm(marker)
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const ctx = await draftContext("fullTakeover")
      const result = await (
        await BashTool.init()
      ).execute({ command: "git log -1 -p", description: "Inspect history" }, ctx)
      expect(result.metadata.exit, result.output).toBe(0)
      await expect(fs.stat(marker)).rejects.toMatchObject({ code: "ENOENT" })
    },
  })
})

test("external raw Git commands cannot claim the controlled built-in history permission", async () => {
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const ctx = await draftContext("fullTakeover")
      await expect(
        decideExternal(
          { sessionID: ctx.sessionID, executionID: "external-raw-git", cwd: tmp.path },
          { kind: "command", command: "git log -1" },
        ),
      ).rejects.toBeInstanceOf(TaskScope.DeniedError)
    },
  })
})
