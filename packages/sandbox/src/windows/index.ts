/// <reference path="../runtime.d.ts" />
/**
 * Windows backend: commands run as a hidden low-privilege local account. NTFS permissions decide what it can read
 * and write, a firewall rule blocks its outbound traffic except loopback (so the network goes through the sandbox
 * proxy), and a job object ends the whole process tree when the command is stopped.
 *
 * Setup needs administrator approval once (account and firewall rule); everything else runs as the user.
 * Windows does not filter loopback, nor traffic to the machine's own addresses, so local services stay reachable:
 * the engine relies on its password and process-tree check there.
 */
import { execFile, spawn } from "node:child_process"
import { createHash, randomInt, randomUUID } from "node:crypto"
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { promisify } from "node:util"
import source from "./helper.cs" with { type: "text" }
import setupScript from "./setup.ps1" with { type: "text" }
import resetScript from "./reset.ps1" with { type: "text" }
import { ChildEnv } from "@merakcode/util/child-env"
import { Paths } from "@merakcode/util/paths"
import type { Backend, Status } from "../backend"
import { Policy } from "../policy"
import { WindowsCommand } from "./command"

const run = promisify(execFile)

export namespace WindowsSandbox {
  export const ACCOUNT = "merakcode-sbx"
  export const RULE = "merakcode-sandbox-block"

  type State = { sid: string; granted: { path: string; rule: string }[] }

  const system = process.env.SystemRoot ?? "C:\\Windows"
  const powershell = path.join(system, "System32", "WindowsPowerShell", "v1.0", "powershell.exe")

  /** The C# compiler of .NET Framework 4, part of every supported Windows */
  export function compiler() {
    return ["FrameworkArm64", "Framework64", "Framework"]
      .map((dir) => path.join(system, "Microsoft.NET", dir, "v4.0.30319", "csc.exe"))
      .find((file) => existsSync(file))
  }

  /** 32 characters with upper and lower case letters, digits and symbols */
  function password() {
    const sets = ["ABCDEFGHJKLMNPQRSTUVWXYZ", "abcdefghijkmnopqrstuvwxyz", "23456789", "!#%*+-=?@^_"]
    const all = sets.join("")
    const chars = [
      ...sets.map((set) => set[randomInt(set.length)]!),
      ...Array.from({ length: 28 }, () => all[randomInt(all.length)]!),
    ]
    for (let i = chars.length - 1; i > 0; i--) {
      const j = randomInt(i + 1)
      ;[chars[i], chars[j]] = [chars[j]!, chars[i]!]
    }
    return chars.join("")
  }

  async function admin() {
    return run("net", ["session"], { windowsHide: true }).then(
      () => true,
      () => false,
    )
  }

  export function create(options: { root?: string; home?: string } = {}): Backend {
    const root = options.root ?? path.join(Paths.data, "sandbox")
    const home = options.home ?? os.homedir()
    const file = {
      state: path.join(root, "state.json"),
      password: path.join(root, "password.bin"),
      requests: path.join(root, "requests"),
      tmp: path.join(root, "tmp"),
      appdata: path.join(root, "appdata"),
      bin: path.join(root, "bin"),
    }

    const load = (): State | undefined => {
      try {
        return JSON.parse(readFileSync(file.state, "utf8")) as State
      } catch {
        return undefined
      }
    }
    const save = (state: State) => writeFileSync(file.state, JSON.stringify(state, null, 2))

    async function helper() {
      const hash = createHash("sha256").update(source).digest("hex").slice(0, 12)
      const exe = path.join(file.bin, `helper-${hash}.exe`)
      if (existsSync(exe)) return exe
      const csc = compiler()
      if (!csc) throw new Error("The C# compiler that ships with Windows (csc.exe) is missing")
      mkdirSync(file.bin, { recursive: true })
      const code = path.join(file.bin, `helper-${hash}.cs`)
      writeFileSync(code, source)
      await run(csc, ["/nologo", "/target:exe", "/optimize", `/out:${exe}`, "/r:System.Security.dll", code], {
        windowsHide: true,
      })
      return exe
    }

    /** Adds one permission entry for the sandbox account, once, and remembers it for reset */
    async function grant(
      state: State,
      target: string,
      kind: "/grant" | "/deny",
      rights: { dir: string; file: string },
    ) {
      const stat = statSync(target, { throwIfNoEntry: false })
      if (!stat) return
      const rule = `${kind} *${state.sid}:${stat.isDirectory() ? rights.dir : rights.file}`
      if (state.granted.some((entry) => entry.path === target && entry.rule === rule)) return
      await run("icacls", [target, kind, rule.slice(kind.length + 1), "/c", "/q"], {
        windowsHide: true,
        maxBuffer: 64 * 1024 * 1024,
      })
      state.granted.push({ path: target, rule })
      save(state)
    }
    const RIGHTS = {
      read: { dir: "(OI)(CI)RX", file: "RX" },
      write: { dir: "(OI)(CI)M", file: "M" },
      denyRead: { dir: "(OI)(CI)R", file: "R" },
      denyWrite: { dir: "(OI)(CI)(WD,AD,WEA,WA,DE,DC)", file: "(WD,AD,WEA,WA,DE)" },
      denyAll: { dir: "(OI)(CI)F", file: "F" },
    }

    /** Runs a script with administrator rights: directly when already elevated (CI), otherwise through UAC */
    async function elevated(script: string, args: string[]) {
      const ps1 = path.join(root, `elevated-${randomUUID()}.ps1`)
      writeFileSync(ps1, script)
      try {
        const argv = ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", ps1, ...args]
        const env = WindowsCommand.powershellEnv(process.env)
        if (await admin()) {
          await run(powershell, argv, { windowsHide: true, env })
          return
        }
        const list = argv.map((arg) => `'"${arg.replaceAll("'", "''")}"'`).join(",")
        await run(
          powershell,
          [
            "-NoProfile",
            "-Command",
            `Start-Process -FilePath '${powershell}' -Verb RunAs -Wait -WindowStyle Hidden -ArgumentList ${list}`,
          ],
          { windowsHide: true, env },
        ).catch(() => {
          throw new Error("The sandbox setup needs administrator approval, and it was not given")
        })
      } finally {
        rmSync(ps1, { force: true })
      }
    }

    async function status(): Promise<Status> {
      if (!compiler())
        return {
          status: "unsupported",
          reason: "The C# compiler that ships with Windows (.NET Framework 4, csc.exe) is missing",
        }
      if (!load() || !existsSync(file.password))
        return {
          status: "unsupported",
          installable: true,
          reason: "The sandbox needs a one-time setup with administrator approval",
        }
      return { status: "on", backend: "windows-account", degraded: ["loopback-not-restricted"] }
    }

    return {
      status,
      tmp: () => file.tmp,

      async warm() {
        if (!load() || !existsSync(file.password) || !compiler()) return
        await helper()
      },

      async setup(progress = () => {}) {
        if (!compiler()) return status()
        mkdirSync(root, { recursive: true })
        progress("Creating the sandbox account. Windows will ask for administrator approval.")
        const secret = password()
        const request = path.join(root, `setup-${randomUUID()}.json`)
        writeFileSync(
          request,
          JSON.stringify({ user: ACCOUNT, password: secret, rule: RULE, ranges: WindowsCommand.BLOCKED }),
        )
        try {
          await elevated(setupScript, ["-Request", request])
        } finally {
          rmSync(request, { force: true })
        }
        const result = (() => {
          try {
            return JSON.parse(readFileSync(request + ".result", "utf8")) as { sid?: string; error?: string }
          } catch {
            return {}
          }
        })()
        rmSync(request + ".result", { force: true })
        if (!result.sid) throw new Error(`Sandbox setup failed: ${result.error ?? "the setup script did not finish"}`)

        const exe = await helper()
        await new Promise<void>((resolve, reject) => {
          const child = spawn(exe, ["protect", file.password], { windowsHide: true, stdio: ["pipe", "ignore", "pipe"] })
          let error = ""
          child.stderr.on("data", (chunk: Buffer) => (error += chunk))
          child.on("error", reject)
          child.on("close", (code) =>
            code === 0 ? resolve() : reject(new Error(`Saving the sandbox password failed: ${error}`)),
          )
          child.stdin.end(secret + "\n")
        })
        const state: State = { sid: result.sid, granted: [] }
        save(state)

        progress("Letting the sandbox read your user folder. This can take a few minutes the first time.")
        await grant(state, home, "/grant", RIGHTS.read)
        progress("Hiding credential folders from the sandbox.")
        for (const dir of Policy.SENSITIVE_HOME_DIRS) await grant(state, path.join(home, dir), "/deny", RIGHTS.denyRead)
        progress("Preparing the sandbox's own folders.")
        for (const dir of [file.tmp, file.appdata, file.requests]) mkdirSync(dir, { recursive: true })
        for (const dir of [file.tmp, file.appdata]) await grant(state, dir, "/grant", RIGHTS.write)
        for (const target of [file.requests, file.password, file.state, file.bin])
          await grant(state, target, "/deny", RIGHTS.denyAll)
        for (const dir of Policy.CACHE_DIRS) await grant(state, path.join(home, dir), "/grant", RIGHTS.write)
        return status()
      },

      async reset() {
        const state = load()
        // Before the account is deleted: afterwards its SID can no longer be resolved
        if (state)
          for (const entry of [...state.granted].reverse())
            await run("icacls", [entry.path, "/remove", `*${state.sid}`, "/c", "/q"], { windowsHide: true }).catch(
              () => {},
            )
        mkdirSync(root, { recursive: true })
        const result = path.join(root, `reset-${randomUUID()}.json`)
        await elevated(resetScript, ["-User", ACCOUNT, "-Rule", RULE, "-Result", result])
        rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
        return status()
      },

      async wrap(input) {
        const state = load()
        if (!state) throw new Error("The sandbox has not been set up")
        const exe = await helper()
        for (const dir of input.policy.write.allow) await grant(state, dir, "/grant", RIGHTS.write)
        for (const target of input.policy.write.protect) await grant(state, target, "/deny", RIGHTS.denyWrite)
        for (const target of [
          ...input.policy.read.deny,
          ...Policy.SENSITIVE_HOME_DIRS.map((dir) => path.join(home, dir)),
        ])
          await grant(state, target, "/deny", RIGHTS.denyRead)
        mkdirSync(file.requests, { recursive: true })
        const request = path.join(file.requests, randomUUID())
        writeFileSync(
          request,
          WindowsCommand.request({
            user: ACCOUNT,
            password: file.password,
            cwd: input.cwd,
            file: input.shell,
            args: WindowsCommand.line(input.shell, input.command),
            env: { ...input.env, LOCALAPPDATA: file.appdata },
          }),
        )
        return {
          file: exe,
          args: ["run", request],
          env: ChildEnv.build({}),
          cleanup: () => rmSync(request, { force: true }),
        }
      },
    }
  }
}
