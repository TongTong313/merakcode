import { native } from "@merakcode/util/ffi"
import { Process } from "@merakcode/util/process"
import { setTimeout as delay } from "node:timers/promises"
import { Shell } from "../../infra/process/shell/shell"
import { Text } from "../prompt/text"
import fs from "node:fs/promises"

/** Owns the adapter's descendants before its first protocol request can start a CLI. */
export async function containAdapter(child: Process.Child, marker: string): Promise<() => Promise<void>> {
  if (process.platform !== "win32")
    return async () => {
      await Shell.killTree(child)
      if (!child.pid) return
      for (;;) {
        const listing = await Process.run(["/bin/ps", "-A", "-o", "pgid=", "-o", "stat="], { nothrow: true })
        if (listing.exitCode !== 0)
          throw new Error(
            await Text.pick({
              zh: "无法确认外部进程组已退出",
              en: "Could not confirm the external process group exited",
            }),
          )
        const active = listing
          .text()
          .split("\n")
          .some((line) => {
            const [group, status] = line.trim().split(/\s+/)
            return Number(group) === child.pid && !status?.startsWith("Z")
          })
        const descendants = await taggedProcesses(marker)
        for (const pid of descendants)
          try {
            process.kill(pid, "SIGKILL")
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error
          }
        if (!active && !descendants.length) return
        await delay(10)
      }
    }

  const lib = native()
  if (!lib)
    throw new Error(
      await Text.pick({ zh: "无法管理外部产品的进程树", en: "Could not manage the external product's process tree" }),
    )
  const failure = async (operation: string) => {
    const code = lib.call("kernel32.dll", "GetLastError", [], "u32", [])
    return new Error(
      await Text.pick(
        {
          zh: "外部进程管理失败：{operation}（{code}）",
          en: "External process management failed: {operation} ({code})",
        },
        { operation, code: String(code) },
      ),
    )
  }
  const job = lib.call("kernel32.dll", "CreateJobObjectW", ["ptr", "ptr"], "ptr", [0n, 0n])
  if (!job) throw await failure("CreateJobObjectW")
  try {
    // JOBOBJECT_EXTENDED_LIMIT_INFORMATION; nested jobs do not allow a detached CLI to break away.
    const limits = Buffer.alloc(process.arch === "ia32" ? 112 : 144)
    limits.writeUInt32LE(0x2000, 16) // JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
    if (
      !lib.call("kernel32.dll", "SetInformationJobObject", ["ptr", "i32", "ptr", "u32"], "i32", [
        job,
        9,
        lib.pointer(limits),
        limits.length,
      ])
    )
      throw await failure("SetInformationJobObject")
    const handle = lib.call("kernel32.dll", "OpenProcess", ["u32", "i32", "u32"], "ptr", [0x0101, 0, child.pid!])
    if (!handle) throw await failure("OpenProcess")
    try {
      if (!lib.call("kernel32.dll", "AssignProcessToJobObject", ["ptr", "ptr"], "i32", [job, handle]))
        throw await failure("AssignProcessToJobObject")
    } finally {
      lib.call("kernel32.dll", "CloseHandle", ["ptr"], "i32", [handle])
    }
    return async () => {
      try {
        if (!lib.call("kernel32.dll", "TerminateJobObject", ["ptr", "u32"], "i32", [job, 1]))
          throw await failure("TerminateJobObject")
        const accounting = Buffer.alloc(48)
        for (;;) {
          if (
            !lib.call("kernel32.dll", "QueryInformationJobObject", ["ptr", "i32", "ptr", "u32", "ptr"], "i32", [
              job,
              1,
              lib.pointer(accounting),
              accounting.length,
              0n,
            ])
          )
            throw await failure("QueryInformationJobObject")
          if (accounting.readUInt32LE(40) === 0) return
          await delay(10)
        }
      } finally {
        lib.call("kernel32.dll", "CloseHandle", ["ptr"], "i32", [job])
      }
    }
  } catch (error) {
    lib.call("kernel32.dll", "CloseHandle", ["ptr"], "i32", [job])
    throw error
  }
}

/** The inherited run marker still identifies a descendant after it creates a new session or loses its parent. */
async function taggedProcesses(marker: string): Promise<number[]> {
  const variable = `MERAKCODE_ADAPTER_RUN=${marker}`
  if (process.platform === "linux") {
    const result: number[] = []
    for (const pid of await fs.readdir("/proc")) {
      if (!/^\d+$/.test(pid)) continue
      const environment = await fs.readFile(`/proc/${pid}/environ`, "utf8").catch(() => "")
      if (!environment.split("\0").includes(variable)) continue
      const stat = await fs.readFile(`/proc/${pid}/stat`, "utf8").catch(() => "")
      if (!stat || stat.slice(stat.lastIndexOf(")") + 2).startsWith("Z")) continue
      result.push(Number(pid))
    }
    return result
  }
  const listing = await Process.run(["/bin/ps", "-A", "-Eww", "-o", "pid=,stat=,command="], { nothrow: true })
  if (listing.exitCode !== 0)
    throw new Error(
      await Text.pick({ zh: "无法确认外部进程已退出", en: "Could not confirm the external processes exited" }),
    )
  return listing
    .text()
    .split("\n")
    .flatMap((line) => {
      if (!line.split(/\s+/).includes(variable)) return []
      const match = /^\s*(\d+)\s+(\S+)/.exec(line)
      return match && !match[2]!.startsWith("Z") ? [Number(match[1])] : []
    })
}
