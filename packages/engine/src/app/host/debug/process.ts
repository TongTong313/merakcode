// `merak debug process`: list background jobs and processes started by the engine.
import { Installation } from "../../../infra/installation"
import { BashJobStore } from "../../../agent/tools/bash-background"
import { Process } from "@merakcode/util/process"

async function processes() {
  if (process.platform === "win32") {
    const script = [
      "Get-CimInstance Win32_Process",
      "Where-Object { $_.Name -match 'bun|merak|node|language-server|mcp' -or $_.CommandLine -match 'bun|merakcode|language-server|mcp' }",
      "Select-Object ProcessId,ParentProcessId,Name,CommandLine,WorkingSetSize",
      "ConvertTo-Json -Compress",
    ].join(" | ")
    const proc = Process.spawn(["powershell", "-NoProfile", "-NonInteractive", "-Command", script], {
      stdout: "pipe",
      stderr: "ignore",
    })
    const output = await new Response(proc.stdout).text()
    await proc.exited
    return JSON.parse(output || "[]")
  }

  const proc = Process.spawn(["ps", "-eo", "pid=,ppid=,rss=,comm=,args="], {
    stdout: "pipe",
    stderr: "ignore",
  })
  const output = await new Response(proc.stdout).text()
  await proc.exited
  return output
    .split("\n")
    .filter((line) => /bun|merak|node|language-server|mcp/i.test(line))
    .map((line) => line.trim())
}

export async function run() {
  const memory = process.memoryUsage()
  const mb = (value: number) => Math.round((value / 1024 / 1024) * 100) / 100
  const related = await processes().catch((error) => ({
    error: error instanceof Error ? error.message : String(error),
  }))

  console.log(
    JSON.stringify(
      {
        merakCode: Installation.VERSION,
        runtime: `${process.release.name} ${process.version}`,
        platform: `${process.platform}-${process.arch}`,
        pid: process.pid,
        ppid: process.ppid,
        execPath: process.execPath,
        memoryMB: Object.fromEntries(Object.entries(memory).map(([key, value]) => [key, mb(value)])),
        backgroundJobs: BashJobStore.running().map((job) => ({
          id: job.id,
          pid: job.pid,
          command: job.command,
          startedAt: job.startedAt,
        })),
        relatedProcesses: related,
      },
      null,
      2,
    ),
  )
}
