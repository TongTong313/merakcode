import { native } from "@merakcode/util/ffi"
import { Process } from "@merakcode/util/process"
import { setTimeout as delay } from "node:timers/promises"
import { Shell } from "./shell/shell"
import type { Text } from "@merakcode/util/text"
import fs from "node:fs/promises"

type Pick = (text: Text.Pair, params?: Record<string, unknown>) => Promise<string>

/** Contains descendants before the child is allowed to start work. */
export async function containProcess(
  child: Process.Child,
  marker: { name: string; value: string },
  pick: Pick,
): Promise<() => Promise<void>> {
  if (process.platform !== "win32")
    return async () => {
      await Shell.killTree(child)
      if (!child.pid) return
      for (;;) {
        const listing = await Process.run(["/bin/ps", "-A", "-o", "pgid=", "-o", "stat="], { nothrow: true })
        if (listing.exitCode !== 0)
          throw new Error(
            await pick({
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
        const descendants = await taggedProcesses(marker, pick)
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
      await pick({ zh: "无法管理外部产品的进程树", en: "Could not manage the external product's process tree" }),
    )
  const failure = async (operation: string) => {
    const code = lib.call("kernel32.dll", "GetLastError", [], "u32", [])
    return new Error(
      await pick(
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
      const processes: (bigint | number)[] = []
      try {
        const width = process.arch === "ia32" ? 4 : 8
        let ids = Buffer.alloc(8 + 64 * width)
        while (
          !lib.call("kernel32.dll", "QueryInformationJobObject", ["ptr", "i32", "ptr", "u32", "ptr"], "i32", [
            job,
            3,
            lib.pointer(ids),
            ids.length,
            0n,
          ])
        ) {
          if (Number(lib.call("kernel32.dll", "GetLastError", [], "u32", [])) !== 234)
            throw await failure("QueryInformationJobObject")
          ids = Buffer.alloc(ids.length * 2)
        }
        for (let index = 0; index < ids.readUInt32LE(4); index++) {
          const offset = 8 + index * width
          const pid = width === 8 ? Number(ids.readBigUInt64LE(offset)) : ids.readUInt32LE(offset)
          const handle = lib.call("kernel32.dll", "OpenProcess", ["u32", "i32", "u32"], "ptr", [0x101000, 0, pid])
          if (handle) {
            const member = Buffer.alloc(4)
            if (
              !lib.call("kernel32.dll", "IsProcessInJob", ["ptr", "ptr", "ptr"], "i32", [
                handle,
                job,
                lib.pointer(member),
              ])
            ) {
              const error = await failure("IsProcessInJob")
              lib.call("kernel32.dll", "CloseHandle", ["ptr"], "i32", [handle])
              throw error
            }
            if (member.readInt32LE()) processes.push(handle)
            else lib.call("kernel32.dll", "CloseHandle", ["ptr"], "i32", [handle])
          } else if (Number(lib.call("kernel32.dll", "GetLastError", [], "u32", [])) !== 87)
            throw await failure("OpenProcess")
        }
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
          // ActiveProcesses can reach zero before the process objects signal completion of termination and I/O.
          const exited = processes.map((handle) =>
            Number(lib.call("kernel32.dll", "WaitForSingleObject", ["ptr", "u32"], "u32", [handle, 0])),
          )
          if (exited.includes(0xffffffff)) throw await failure("WaitForSingleObject")
          if (accounting.readUInt32LE(40) === 0 && exited.every((state) => state === 0)) return
          await delay(10)
        }
      } finally {
        for (const handle of processes) lib.call("kernel32.dll", "CloseHandle", ["ptr"], "i32", [handle])
        lib.call("kernel32.dll", "CloseHandle", ["ptr"], "i32", [job])
      }
    }
  } catch (error) {
    lib.call("kernel32.dll", "CloseHandle", ["ptr"], "i32", [job])
    throw error
  }
}

/** The inherited run marker still identifies a descendant after it creates a new session or loses its parent. */
export async function taggedProcesses(
  marker: { name: string; value: string },
  pick: Pick = async (text) => text.en,
): Promise<number[]> {
  if (process.platform === "win32") return []
  const variable = `${marker.name}=${marker.value}`
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
    throw new Error(await pick({ zh: "无法确认外部进程已退出", en: "Could not confirm the external processes exited" }))
  return listing
    .text()
    .split("\n")
    .flatMap((line) => {
      if (!line.split(/\s+/).includes(variable)) return []
      const match = /^\s*(\d+)\s+(\S+)/.exec(line)
      return match && !match[2]!.startsWith("Z") ? [Number(match[1])] : []
    })
}
