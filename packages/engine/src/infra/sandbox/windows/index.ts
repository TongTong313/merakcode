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
import type { BasePolicy } from "../policy"
import { WindowsCommand } from "./command"
import { Lock } from "../../concurrency/lock"

const run = promisify(execFile)

export namespace WindowsSandbox {
  export const ACCOUNT = "merakcode-sbx"
  export const RULE = "merakcode-sandbox-block"

  type State = { sid: string; granted: { path: string; rule: string }[] }

  const system = process.env.SystemRoot ?? "C:\\Windows"
  const powershell = path.join(system, "System32", "WindowsPowerShell", "v1.0", "powershell.exe")
  const probes = new Map<string, { signature: string; retryAt: number; pending: Promise<Status> }>()
  const restriction = () =>
    `S-1-5-21-${randomInt(1, 0xffffffff)}-${randomInt(1, 0xffffffff)}-${randomInt(1, 0xffffffff)}-${randomInt(1, 0xffffffff)}`
  function directoryRestriction(target: string) {
    const hash = createHash("sha256").update(path.resolve(target).toLowerCase()).digest()
    return `S-1-5-21-${hash.readUInt32LE(0)}-${hash.readUInt32LE(4)}-${hash.readUInt32LE(8)}-${hash.readUInt32LE(12)}`
  }

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

  export function create(base: BasePolicy, options: { root?: string; home?: string } = {}): Backend {
    const root = options.root ?? path.join(Paths.data, "sandbox")
    const home = options.home ?? os.homedir()
    const file = {
      state: path.join(root, "state.json"),
      password: path.join(root, "password.bin"),
      requests: path.join(root, "requests"),
      tmp: path.join(root, "tmp", "restricted"),
      appdata: path.join(root, "appdata", "restricted"),
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
    const signature = () =>
      createHash("sha256").update(readFileSync(file.state)).update(readFileSync(file.password)).digest("hex")

    async function helper() {
      const hash = createHash("sha256").update(source).digest("hex").slice(0, 12)
      const exe = path.join(file.bin, `helper-${hash}.exe`)
      using _ = await Lock.write(`windows-sandbox-helper:${exe}`)
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
      try {
        await run("icacls", [target, kind, rule.slice(kind.length + 1), "/c", "/q"], {
          windowsHide: true,
          maxBuffer: 64 * 1024 * 1024,
        })
      } catch (error) {
        // Native Windows tools use the system code page; their raw stderr is retained in the cause.
        const code = error && typeof error === "object" && "code" in error ? error.code : "unknown"
        throw new Error(`Windows sandbox file permissions could not be updated for ${target} (icacls exit ${code})`, {
          cause: error,
        })
      }
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
      const version = signature()
      const cached = probes.get(root)
      if (cached?.signature === version && Date.now() < cached.retryAt) return cached.pending
      const pending = (async (): Promise<Status> => {
        using _ = await Lock.write(`windows-sandbox-prepare:${root}`)
        const request = path.join(file.requests, `probe-${randomUUID()}`)
        try {
          const exe = await helper()
          const state = load()!
          await grant(state, exe, "/grant", RIGHTS.read)
          mkdirSync(file.requests, { recursive: true })
          mkdirSync(file.tmp, { recursive: true })
          writeFileSync(
            request,
            WindowsCommand.request({
              user: ACCOUNT,
              password: file.password,
              cwd: file.tmp,
              file: path.join(system, "System32", "cmd.exe"),
              args: "/d /c exit 0",
              env: {
                SystemRoot: system,
                TEMP: file.tmp,
                TMP: file.tmp,
                MERAKCODE_SANDBOX_WRITE_SIDS: restriction(),
                MERAKCODE_SANDBOX_PROBE: "1",
              },
            }),
          )
          writeFileSync(request + ".started", "")
          await run("icacls", [request + ".started", "/grant", `*${state.sid}:M`, "/c", "/q"], { windowsHide: true })
          const { stdout } = await run(exe, ["run", request], { windowsHide: true, timeout: 30_000 })
          if (stdout.trim() !== state.sid) throw new Error("The sandbox account identity changed")
          return {
            status: "on",
            backend: "windows-account",
            degraded: ["loopback-not-restricted", "ambient-world-writable"],
          }
        } catch (error) {
          const failed = error as NodeJS.ErrnoException & { stdout?: string }
          const detail = [
            failed instanceof Error ? failed.message : String(error),
            failed.code ? `code ${failed.code}` : "",
            failed.stdout?.trim() ?? "",
          ]
            .filter(Boolean)
            .join(" ")
          return {
            status: "failed",
            backend: "windows-account",
            reason: `The sandbox account could not start a process: ${detail}`,
          }
        } finally {
          rmSync(request, { force: true })
          rmSync(request + ".started", { force: true })
        }
      })()
      const entry = { signature: version, retryAt: Infinity, pending }
      probes.set(root, entry)
      void pending.then((result) => {
        if (probes.get(root) !== entry) return
        // Share concurrent probes, but never retain a successful login as permanent readiness.
        if (result.status === "on") probes.delete(root)
        else entry.retryAt = Date.now() + 30_000
      })
      return pending
    }

    return {
      status,
      tmp: () => file.tmp,

      async warm() {
        await status()
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
        probes.delete(root)

        progress("Letting the sandbox read your user folder. This can take a few minutes the first time.")
        await grant(state, home, "/grant", RIGHTS.read)
        progress("Hiding credential folders from the sandbox.")
        for (const dir of base.readDeny) await grant(state, dir, "/deny", RIGHTS.denyRead)
        progress("Preparing the sandbox's own folders.")
        for (const dir of [file.tmp, file.appdata, file.requests]) mkdirSync(dir, { recursive: true })
        for (const dir of [file.tmp, file.appdata]) await grant(state, dir, "/grant", RIGHTS.write)
        for (const target of [file.requests, file.password, file.state, file.bin])
          await grant(state, target, "/deny", RIGHTS.denyAll)
        for (const dir of base.writeAllow) await grant(state, dir, "/grant", RIGHTS.write)
        return status()
      },

      async reset() {
        probes.delete(root)
        const state = load()
        // Before the account is deleted: afterwards its SID can no longer be resolved
        if (state)
          for (const entry of [...state.granted].reverse())
            if (entry.rule.startsWith("restricted:")) {
              if (existsSync(entry.path))
                await run(await helper(), ["revoke", entry.rule.slice("restricted:".length), entry.path], {
                  windowsHide: true,
                  timeout: 5000,
                })
            } else
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
        using _ = await Lock.write(`windows-sandbox-prepare:${root}`)
        const state = load()
        if (!state) throw new Error("The sandbox has not been set up")
        const exe = await helper()
        await grant(state, exe, "/grant", RIGHTS.read)
        for (const target of [file.tmp, file.appdata]) {
          mkdirSync(target, { recursive: true })
          await grant(state, target, "/grant", RIGHTS.write)
        }
        const sids = [restriction()]
        for (const dir of input.policy.write.allow) await grant(state, dir, "/grant", RIGHTS.write)
        for (const target of new Set([...input.policy.write.allow, file.tmp, file.appdata])) {
          const stat = statSync(target, { throwIfNoEntry: false })
          if (!stat) continue
          const sid = directoryRestriction(target)
          await run(exe, ["grant", sid, target], { windowsHide: true, timeout: 5000 })
          sids.push(sid)
          const rule = `restricted:${sid}`
          if (!state.granted.some((entry) => entry.path === target && entry.rule === rule)) {
            state.granted.push({ path: target, rule })
            save(state)
          }
        }
        for (const target of input.policy.write.protect) await grant(state, target, "/deny", RIGHTS.denyWrite)
        for (const target of [...input.policy.read.deny, ...base.readDeny])
          await grant(state, target, "/deny", RIGHTS.denyRead)
        mkdirSync(file.requests, { recursive: true })
        const request = path.join(file.requests, randomUUID())
        const env = Object.fromEntries(
          Object.entries(input.env).filter(
            ([key]) => !["MERAKCODE_SANDBOX_WRITE_SIDS", "MERAKCODE_SANDBOX_PROBE"].includes(key.toUpperCase()),
          ),
        )
        writeFileSync(
          request,
          WindowsCommand.request({
            user: ACCOUNT,
            password: file.password,
            cwd: input.cwd,
            file: input.shell,
            args: WindowsCommand.line(input.shell, input.command),
            env: { ...env, LOCALAPPDATA: file.appdata, MERAKCODE_SANDBOX_WRITE_SIDS: sids.join(",") },
          }),
        )
        writeFileSync(request + ".started", "")
        await run("icacls", [request + ".started", "/grant", `*${state.sid}:M`, "/c", "/q"], { windowsHide: true })
        return {
          file: exe,
          args: ["run", request],
          env: ChildEnv.build({}),
          cleanup: (output = "", exitCode?: number | null) => {
            if (
              exitCode === 125 &&
              (!existsSync(request + ".started") || readFileSync(request + ".started", "utf8") !== "started")
            )
              probes.set(root, {
                signature: signature(),
                retryAt: Date.now() + 30_000,
                pending: Promise.resolve({
                  status: "failed",
                  backend: "windows-account",
                  reason: `The sandbox could not start the command: ${output.trim()}`,
                }),
              })
            rmSync(request, { force: true })
            rmSync(request + ".started", { force: true })
          },
        }
      },
    }
  }
}
