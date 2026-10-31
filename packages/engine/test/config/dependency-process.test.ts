import { afterEach, expect, test, vi } from "vitest"
import fs from "node:fs/promises"
import path from "node:path"
import { evaluate, tmpdir } from "../fixture/fixture"
import { Process } from "@merakcode/util/process"
import { Npm } from "../../src/infra/package"
import { native } from "@merakcode/util/ffi"
import { setTimeout as sleep } from "node:timers/promises"

afterEach(() => vi.unstubAllEnvs())

test.skipIf(process.platform !== "win32")(
  "dependency installation errors include the failed Windows operation and error code",
  async ({ signal }) => {
    await using tmp = await tmpdir()
    const result = await Process.run(
      evaluate(`
        import { createRequire } from "node:module"
        import { Npm } from ${JSON.stringify(new URL("../../src/infra/package/index.ts", import.meta.url).href)}
        const ffi = createRequire(import.meta.url)("node:ffi")
        const load = ffi.dlopen
        // Inject an OS failure without replacing installation, process containment or error formatting.
        ffi.dlopen = (library, functions) => {
          if (library === "kernel32.dll" && functions.SetInformationJobObject)
            return { functions: { SetInformationJobObject: () => 0 } }
          if (library === "kernel32.dll" && functions.GetLastError)
            return { functions: { GetLastError: () => 5 } }
          return load(library, functions)
        }
        try {
          await Npm.installDependencies(${JSON.stringify(tmp.path)})
        } catch (error) {
          console.log(error.message)
        }
      `),
      { signal },
    )
    expect(result.text().trim()).toBe("External process management failed: SetInformationJobObject (5)")
  },
)

test.for(["abort", "npm exit"])("%s stops real npm lifecycle writers before returning", async (stop, context) => {
  await using tmp = await tmpdir()
  const pkg = path.join(tmp.path, "package")
  const installed = path.join(tmp.path, "installed")
  const started = path.join(tmp.path, "started")
  const gate = path.join(tmp.path, "release")
  const late = path.join(installed, "late.txt")
  vi.stubEnv("npm_config_cache", path.join(tmp.path, "cache"))
  await fs.mkdir(pkg)
  await fs.mkdir(installed)
  await fs.writeFile(
    path.join(pkg, "package.json"),
    JSON.stringify({ name: "local-writer", version: "1.0.0", scripts: { postinstall: "node install.cjs" } }),
  )
  await fs.writeFile(
    path.join(pkg, "writer.cjs"),
    `const fs = require("node:fs");
     fs.writeFileSync(${JSON.stringify(started)}, String(process.pid));
     const timer = setInterval(() => {
       if (!fs.existsSync(${JSON.stringify(gate)})) return;
       fs.writeFileSync(${JSON.stringify(late)}, "late write"); clearInterval(timer);
     }, 10)`,
  )
  await fs.writeFile(
    path.join(pkg, "install.cjs"),
    `const { spawn } = require("node:child_process"); const fs = require("node:fs");
     spawn(process.execPath, [require("node:path").join(__dirname, "writer.cjs")], { detached: true, stdio: "ignore", windowsHide: true });
     const timer = setInterval(() => { if (fs.existsSync(${JSON.stringify(gate)})) clearInterval(timer) }, 10)`,
  )
  await Process.run([...Npm.command(), "pack", "--ignore-scripts", "--offline"], { cwd: pkg, signal: context.signal })
  await fs.writeFile(
    path.join(installed, "package.json"),
    JSON.stringify({ private: true, dependencies: { "local-writer": "file:../package/local-writer-1.0.0.tgz" } }),
  )
  const abort = new AbortController()
  let settled = false
  let runningAtReturn: Promise<boolean> | undefined
  let npm = 0
  let failure: unknown
  const installing = Npm.installDependencies(
    installed,
    AbortSignal.any([abort.signal, context.signal]),
    async (pid) => {
      npm = pid
    },
  )
    .catch((error) => {
      failure = error
    })
    .finally(() => {
      runningAtReturn = writer ? running() : Promise.resolve(false)
      settled = true
    })
  let writer = 0
  const lib = process.platform === "win32" ? native() : undefined
  let handle: bigint | number = 0n
  const running = async () => {
    if (process.platform !== "win32") {
      const result = await Process.run(["/bin/ps", "-p", String(writer), "-o", "stat=,args="], { nothrow: true })
      return result.text().includes(installed) && !result.text().trim().startsWith("Z")
    }
    return lib!.call("kernel32.dll", "WaitForSingleObject", ["ptr", "u32"], "u32", [handle, 0]) === 258
  }
  try {
    // Readiness uses the test's overall cancellation, not a second startup deadline for npm.
    for (;;) {
      context.signal.throwIfAborted()
      const pid = await fs.readFile(started, "utf8").catch(() => undefined)
      if (pid) {
        writer = Number(pid)
        break
      }
      if (settled) throw failure ?? new Error("npm exited before its lifecycle writer started")
      await sleep(10, undefined, { signal: context.signal })
    }
    if (lib) {
      handle = lib.call("kernel32.dll", "OpenProcess", ["u32", "i32", "u32"], "ptr", [0x100001, 0, writer])
      expect(handle).toBeTruthy()
    }
    expect(await running()).toBe(true)
    if (stop === "abort") abort.abort()
    else process.kill(npm)
    await expect.poll(() => settled, { timeout: 10_000 }).toBe(true)
    expect(await runningAtReturn).toBe(false)
    await fs.writeFile(gate, "go")
    await expect(fs.stat(late)).rejects.toMatchObject({ code: "ENOENT" })
  } finally {
    abort.abort()
    await fs.writeFile(gate, "go")
    if (lib && handle) {
      lib.call("kernel32.dll", "TerminateProcess", ["ptr", "u32"], "i32", [handle, 1])
      lib.call("kernel32.dll", "CloseHandle", ["ptr"], "i32", [handle])
    }
    if (writer && !lib) await expect.poll(running).toBe(false)
    await installing
  }
})
