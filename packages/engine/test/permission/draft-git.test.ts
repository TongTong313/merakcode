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
import { pathToFileURL } from "node:url"
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

async function searchConfiguration(directory: string) {
  const program = path.join(directory, process.platform === "win32" ? "hostname.cmd" : "hostname.sh")
  await fs.writeFile(
    program,
    process.platform === "win32"
      ? "@echo changed>effect\r\n@echo audit-host\r\n"
      : "#!/bin/sh\nprintf changed > effect\nprintf audit-host\n",
    { mode: 0o755 },
  )
  const config = path.join(directory, "ripgrep.conf")
  await fs.writeFile(config, `--hostname-bin=${program}\n--hyperlink-format=file://{host}{path}\n--color=always\n`)
  await fs.writeFile(path.join(directory, "input.txt"), "hello\n")
  return config
}

test.each(
  (["ask", "autoApprove", "fullTakeover"] as const).flatMap((level) =>
    (["off", "preferred"] as const).map((sandbox) => ({ level, sandbox })),
  ),
)(
  "draft-only commands reject unproven read-only execution under $level with sandbox $sandbox",
  async ({ level, sandbox }) => {
    using _isolation = readySandbox()
    process.env.MERAKCODE_SANDBOX_MODE = sandbox
    await using tmp = await tmpdir({ git: true })
    await fs.writeFile(path.join(tmp.path, "-v"), "")
    await fs.writeFile(path.join(tmp.path, "-o"), "")
    for (const directory of ["bin", "0"]) {
      await fs.mkdir(path.join(tmp.path, directory))
      await fs.writeFile(path.join(tmp.path, directory, "sort"), "#!/bin/sh\nprintf changed > output.txt\n", {
        mode: 0o755,
      })
    }
    await fs.writeFile(path.join(tmp.path, "input.txt"), "b\na\n")
    await fs.writeFile(path.join(tmp.path, "output.txt"), "keep")
    await fs.writeFile(path.join(tmp.path, "arguments"), "-o\noutput.txt\n")
    await fs.writeFile(path.join(tmp.path, "package.json"), '{"name":"fixture","version":"1.0.0"}')
    await fs.writeFile(path.join(tmp.path, "empty.npmrc"), "")
    await fs.writeFile(path.join(tmp.path, "global.npmrc"), "")
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const ctx = await draftContext(level)
        const replies: Promise<void>[] = []
        const unsubscribe = Bus.subscribe(PermissionNext.Event.Asked, ({ properties }) => {
          replies.push(PermissionNext.reply({ requestID: properties.id, reply: "once" }))
        })
        try {
          const tool = await BashTool.init()
          for (const command of [
            "npm --offline --userconfig=./empty.npmrc --globalconfig=./global.npmrc --cache=./npm-cache --logs-dir=./audit-logs --loglevel=verbose --update-notifier=false list --json",
            "printf '%s\\n' '-o' output.txt | xargs sort input.txt",
            "xargs -a arguments sort input.txt",
            "printf -v PATH ./bin; sort input.txt",
            "printf %n PATH; sort input.txt",
            "printf [-]v PATH ./bin; sort input.txt",
            "sort [-]o output.txt input.txt",
            "sort $'-o' output.txt input.txt",
            "uniq *.txt",
            "uniq -- *.txt",
            "uniq {input.txt,output.txt}",
            "for PATH in ./bin; do sort input.txt; done",
          ]) {
            await expect(
              tool.execute({ command, description: "Inspect input", timeout: 5000 }, ctx),
              command,
            ).rejects.toBeInstanceOf(TaskScope.DeniedError)
            expect(await fs.readFile(path.join(tmp.path, "output.txt"), "utf8"), command).toBe("keep")
          }
          await expect(fs.stat(path.join(tmp.path, "audit-logs"))).rejects.toMatchObject({ code: "ENOENT" })
          if (sandbox === "off") {
            const plain = await tool.execute(
              { command: "printf '%s\\n' header; sort input.txt", description: "Inspect input", timeout: 5000 },
              ctx,
            )
            expect(plain.metadata.exit, plain.output).toBe(0)
            expect(plain.output.replaceAll("\r\n", "\n")).toContain("header\na\nb\n")
          }
          await Loop.prompt({
            sessionID: ctx.sessionID,
            noReply: true,
            model: { providerID: "openai", modelID: "gpt-4" },
            parts: [{ type: "text", text: "Implement the change. Update output.txt from input.txt." }],
          })
          const params = { command: "uniq {input.txt,output.txt}", description: "Update output", timeout: 5000 }
          if (sandbox === "off") {
            const result = await tool.execute(params, ctx)
            expect(result.metadata.exit, result.output).toBe(0)
            expect((await fs.readFile(path.join(tmp.path, "output.txt"), "utf8")).replaceAll("\r\n", "\n")).toBe(
              "b\na\n",
            )
          } else {
            expect((await prepareBashCommand(params, ctx)).readOnly).toBe(false)
          }
          await Promise.all(replies)
        } finally {
          unsubscribe()
        }
      },
    })
  },
)

test("file inputs and aliases keep sensitive approval while ordinary reads stay automatic", async () => {
  using _isolation = readySandbox()
  await using tmp = await tmpdir({ git: true })
  await fs.writeFile(path.join(tmp.path, ".env"), "FAKE_KEY=fixture-only\n")
  await fs.writeFile(path.join(tmp.path, "ordinary.txt"), "ordinary\n")
  await fs.link(path.join(tmp.path, ".env"), path.join(tmp.path, "alias.txt"))
  await fs.link(path.join(tmp.path, ".env"), path.join(tmp.path, "-alias"))
  await fs.link(path.join(tmp.path, ".env"), path.join(tmp.path, "--x=ordinary.txt"))
  await fs.symlink(path.join(tmp.path, ".env"), path.join(tmp.path, "linked.txt"), "file")
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const ctx = await draftContext("autoApprove")
      const shown: PermissionNext.Request[] = []
      const replies: Promise<void>[] = []
      const unsubscribe = Bus.subscribe(PermissionNext.Event.Asked, ({ properties }) => {
        shown.push(properties)
        replies.push(PermissionNext.reply({ requestID: properties.id, reply: "reject" }))
      })
      try {
        for (const [command, target] of [
          ["cat < --x=ordinary.txt", "--x=ordinary.txt"],
          ["env -- cat -- --x=ordinary.txt", "--x=ordinary.txt"],
          ["cat < -alias", "-alias"],
          ["cat -- -alias", "-alias"],
          ["cat alias.txt", "alias.txt"],
          ["cat < linked.txt", ".env"],
          ["diff --from-file=.env ordinary.txt", ".env"],
          ["cat .env", ".env"],
          ["cat < .env", ".env"],
          ["< '.env' cat", ".env"],
          ["cat 0<.env", ".env"],
          ["(cat) < .env", ".env"],
        ] as const) {
          shown.length = 0
          await expect(
            prepareBashCommand({ command, description: "Read fixture input" }, ctx),
            command,
          ).rejects.toBeInstanceOf(PermissionNext.RejectedError)
          expect(shown, command).toHaveLength(1)
          expect(shown[0]!.patterns, command).toContain(PermissionNext.normalizePath(path.join(tmp.path, target)))
          expect(shown[0]!.metadata.tags, command).toContain("sensitive-path")
        }
        shown.length = 0
        for (const command of ["cat < ordinary.txt", "cat 0<&0", "cat <<< '.env'", "cat <<'EOF'\n.env\nEOF"]) {
          expect(
            (await prepareBashCommand({ command, description: "Read ordinary input" }, ctx)).readOnly,
            command,
          ).toBe(true)
        }
        expect(shown).toHaveLength(0)
        await Promise.all(replies)
      } finally {
        unsubscribe()
      }
    },
  })
})

test("indirect file reads require approval before an implementation task runs them", async () => {
  using _isolation = readySandbox()
  await using tmp = await tmpdir({ git: true })
  await fs.writeFile(path.join(tmp.path, ".env"), "FAKE_KEY=fixture-only\n")
  await fs.writeFile(path.join(tmp.path, "input.txt"), "ordinary\n")
  await fs.writeFile(path.join(tmp.path, "file-list"), ".env\0")
  await fs.mkdir(path.join(tmp.path, "nested"))
  await fs.link(path.join(tmp.path, ".env"), path.join(tmp.path, "nested", "public.txt"))
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const ctx = await draftContext("autoApprove")
      await Loop.prompt({
        sessionID: ctx.sessionID,
        noReply: true,
        model: { providerID: "openai", modelID: "gpt-4" },
        parts: [{ type: "text", text: "Implement the requested changes." }],
      })
      const shown: PermissionNext.Request[] = []
      const replies: Promise<void>[] = []
      const unsubscribe = Bus.subscribe(PermissionNext.Event.Asked, ({ properties }) => {
        shown.push(properties)
        replies.push(PermissionNext.reply({ requestID: properties.id, reply: "reject" }))
      })
      try {
        for (const command of [
          "grep --directories=recurse FAKE .",
          "grep -d recurse FAKE .",
          "file -m.env input.txt",
          "jq -f.env input.txt",
          "grep -r FAKE .",
          "rg --hidden --no-ignore FAKE .",
          "rg --hidden --no-ignore FAKE",
          "sort --files0-from=file-list",
          "wc --files0-from=file-list",
          "cd nested && cat public.txt",
          "grep -f.env input.txt",
          "rg -f.env input.txt",
        ]) {
          shown.length = 0
          await expect(
            prepareBashCommand({ command, description: "Inspect project input" }, ctx),
            command,
          ).rejects.toBeInstanceOf(PermissionNext.RejectedError)
          expect(shown, command).toHaveLength(1)
        }
        await Promise.all(replies)
      } finally {
        unsubscribe()
      }
    },
  })
})

test.each(["ask", "autoApprove", "fullTakeover"] as const)(
  "draft-only sorting cannot write through output options under %s",
  async (level) => {
    using _isolation = readySandbox()
    process.env.MERAKCODE_SANDBOX_MODE = "off"
    await using tmp = await tmpdir({ git: true })
    await fs.writeFile(path.join(tmp.path, "input.txt"), "b\na\n")
    await fs.writeFile(path.join(tmp.path, "effect"), "keep")
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const ctx = await draftContext(level)
        const replies: Promise<void>[] = []
        const unsubscribe = Bus.subscribe(PermissionNext.Event.Asked, ({ properties }) => {
          replies.push(PermissionNext.reply({ requestID: properties.id, reply: "once" }))
        })
        try {
          const tool = await BashTool.init()
          const plain = await tool.execute({ command: "sort input.txt", description: "Inspect sorted input" }, ctx)
          expect(plain.metadata.exit, plain.output).toBe(0)
          expect(plain.output.replaceAll("\r\n", "\n")).toContain("a\nb\n")
          for (const option of [
            "--out=effect",
            "--out effect",
            "--output=effect",
            "--output effect",
            "-o effect",
            "-oeffect",
          ])
            await expect(
              tool.execute({ command: `sort ${option} input.txt`, description: "Inspect sorted input" }, ctx),
              option,
            ).rejects.toBeInstanceOf(TaskScope.DeniedError)
          await expect(fs.readFile(path.join(tmp.path, "effect"), "utf8")).resolves.toBe("keep")
          await Promise.all(replies)
        } finally {
          unsubscribe()
        }
      },
    })
  },
)

test.each(["ask", "autoApprove", "fullTakeover"] as const)(
  "draft-only search cannot launch a hostname program under %s",
  async (level) => {
    using _isolation = readySandbox()
    process.env.MERAKCODE_SANDBOX_MODE = "off"
    await using tmp = await tmpdir({ git: true })
    const program = path.join(tmp.path, process.platform === "win32" ? "hostname program.cmd" : "hostname program.sh")
    await fs.writeFile(
      program,
      process.platform === "win32"
        ? "@echo changed>effect\r\n@echo audit-host\r\n"
        : "#!/bin/sh\nprintf changed > effect\nprintf audit-host\n",
      { mode: 0o755 },
    )
    await fs.writeFile(path.join(tmp.path, "input.txt"), "hello\n")
    execFileSync(
      Process.which("rg")!,
      ["--hostname-bin", program, "--hyperlink-format=file://{host}{path}", "--color", "always", "hello", "input.txt"],
      { cwd: tmp.path, windowsHide: true, timeout: 5000 },
    )
    expect((await fs.readFile(path.join(tmp.path, "effect"), "utf8")).trim()).toBe("changed")
    await fs.writeFile(path.join(tmp.path, "effect"), "keep")
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const ctx = await draftContext(level)
        const replies: Promise<void>[] = []
        const unsubscribe = Bus.subscribe(PermissionNext.Event.Asked, ({ properties }) => {
          replies.push(PermissionNext.reply({ requestID: properties.id, reply: "once" }))
        })
        try {
          const tool = await BashTool.init()
          const plain = await tool.execute(
            { command: "rg hello input.txt", description: "Inspect matching input" },
            ctx,
          )
          expect(plain.metadata.exit, plain.output).toBe(0)
          expect(plain.output).toContain("hello")
          for (const separator of ["=", " "]) {
            const command = `rg --hostname-bin${separator}'${program.replaceAll("\\", "/")}' --hyperlink-format='file://{host}{path}' --color always hello input.txt`
            await expect(
              tool.execute({ command, description: "Inspect matching input", timeout: 5000 }, ctx),
            ).rejects.toBeInstanceOf(TaskScope.DeniedError)
            expect(await fs.readFile(path.join(tmp.path, "effect"), "utf8")).toBe("keep")
          }
          await Promise.all(replies)
        } finally {
          unsubscribe()
        }
      },
    })
  },
)

test.each(["rg", "'rg'", "r'g'", 'r"g"', "r\\g", "command 'rg'", "env 'rg'"])(
  "draft-only search rejects an inherited config through %s",
  async (programName) => {
    using _isolation = readySandbox()
    process.env.MERAKCODE_SANDBOX_MODE = "off"
    await using tmp = await tmpdir({ git: true })
    const config = await searchConfiguration(tmp.path)
    const previous = process.env.RIPGREP_CONFIG_PATH
    process.env.RIPGREP_CONFIG_PATH = config
    try {
      execFileSync(Process.which("rg")!, ["hello", "input.txt"], { cwd: tmp.path, windowsHide: true, timeout: 5000 })
      expect((await fs.readFile(path.join(tmp.path, "effect"), "utf8")).trim()).toBe("changed")
      await fs.writeFile(path.join(tmp.path, "effect"), "keep")
      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          const ctx = await draftContext("fullTakeover")
          await expect(
            (await BashTool.init()).execute(
              { command: `${programName} hello input.txt`, description: "Inspect matches" },
              ctx,
            ),
          ).rejects.toBeInstanceOf(TaskScope.DeniedError)
          expect(await fs.readFile(path.join(tmp.path, "effect"), "utf8")).toBe("keep")
        },
      })
    } finally {
      if (previous === undefined) delete process.env.RIPGREP_CONFIG_PATH
      else process.env.RIPGREP_CONFIG_PATH = previous
    }
  },
)

test("draft-only execution rechecks an environment injected by a real plugin", async () => {
  await using tmp = await tmpdir({ git: true })
  const config = await searchConfiguration(tmp.path)
  execFileSync(Process.which("rg")!, ["hello", "input.txt"], {
    cwd: tmp.path,
    env: { ...process.env, RIPGREP_CONFIG_PATH: config },
    timeout: 5000,
    windowsHide: true,
  })
  expect((await fs.readFile(path.join(tmp.path, "effect"), "utf8")).trim()).toBe("changed")
  await fs.writeFile(path.join(tmp.path, "effect"), "keep")
  const plugin = path.join(tmp.path, "environment.mjs")
  await fs.writeFile(
    plugin,
    `export default async () => ({ "shell.env": async (input, output) => {
      if (input.callID === "injected") output.env.RIPGREP_CONFIG_PATH = ${JSON.stringify(config)}
    } })`,
  )
  await fs.writeFile(path.join(tmp.path, "merakcode.json"), JSON.stringify({ plugin: [pathToFileURL(plugin).href] }))
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const ctx = await draftContext("fullTakeover")
      const tool = await BashTool.init()
      const params = { command: "rg hello input.txt", description: "Inspect input", timeout: 5000 }
      const plain = await tool.execute(params, ctx)
      expect(plain.metadata.exit, plain.output).toBe(0)
      expect(plain.output).toContain("hello")
      await expect(tool.execute(params, { ...ctx, callID: "injected" })).rejects.toBeInstanceOf(TaskScope.DeniedError)
      expect(await fs.readFile(path.join(tmp.path, "effect"), "utf8")).toBe("keep")
    },
  })
})

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
