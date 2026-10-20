import { execFile } from "node:child_process"
import { win32 } from "node:path"

// Event 1000 is Application Error's crash record. Do not return Message/XML, paths, user identity or memory dumps.
// https://learn.microsoft.com/troubleshoot/windows-server/performance/troubleshoot-application-service-crashing-behavior
const script = String.raw`
$ErrorActionPreference = 'Stop'
$ids = $env:MC_LOG_CRASH_PIDS -split ','
$rows = @(Get-WinEvent -FilterHashtable @{LogName='Application'; ProviderName='Application Error'; Id=1000; StartTime=(Get-Date).AddDays(-7)} -MaxEvents 100 -ErrorAction SilentlyContinue | ForEach-Object {
  $xml = [xml]$_.ToXml()
  $fields = @{}
  foreach ($entry in $xml.Event.EventData.Data) { $fields[$entry.Name] = [string]$entry.'#text' }
  $number = [string]$fields.ProcessId
  if ($number -match '^0x') { $number = [Convert]::ToUInt32($number.Substring(2),16).ToString() }
  if ($ids -contains $number -and $fields.AppName -match '^(merakcode|merak-bin|merak|bun)\.exe$') {
    @{ timestamp=$_.TimeCreated.ToUniversalTime().ToString('o'); pid=[int]$number; application=$fields.AppName;
       application_version=$fields.AppVersion; module=[IO.Path]::GetFileName($fields.ModuleName);
       module_version=$fields.ModuleVersion; exception_code=$fields.ExceptionCode; fault_offset=$fields.FaultingOffset }
  }
} | Select-Object -First 20)
ConvertTo-Json -InputObject $rows -Compress
`

export function parseWindowsEvents(output: string, runs: { pid: number; started_at?: string; run_id?: string }[]) {
  try {
    const rows: unknown = JSON.parse(output.replace(/^\uFEFF/, ""))
    if (!Array.isArray(rows)) return []
    return rows.slice(0, 20).flatMap((row) => {
      if (!row || typeof row !== "object") return []
      const run = runs.find((run) => run.pid === row.pid)
      if (!run || !/^(merakcode|merak-bin|merak|bun)\.exe$/i.test(row.application ?? "")) return []
      const time = Date.parse(row.timestamp)
      // PID reuse alone is not sufficient correlation.
      const start = Date.parse(run.started_at ?? "")
      if (!Number.isFinite(time) || !Number.isFinite(start) || time < start || time > Date.now()) return []
      const field = (key: string) =>
        typeof row[key] === "string" ? row[key].replace(/[^a-zA-Z0-9_.-]/g, "").slice(0, 120) : undefined
      return [
        {
          run_id: run.run_id,
          pid: row.pid,
          timestamp: new Date(time).toISOString(),
          application: field("application"),
          application_version: field("application_version"),
          module: field("module"),
          module_version: field("module_version"),
          exception_code: field("exception_code"),
          fault_offset: field("fault_offset"),
        },
      ]
    })
  } catch {
    return []
  }
}

export function windowsEvents(
  runs: { pid: number; started_at?: string; run_id?: string }[],
  report: (data: Record<string, unknown>) => void,
) {
  if (process.platform !== "win32" || !runs.length) return
  const pids = runs
    .filter((run) => Number.isFinite(Date.parse(run.started_at ?? "")))
    .map((run) => run.pid)
    .filter((pid) => Number.isInteger(pid) && pid > 0)
    .slice(0, 20)
  if (!pids.length) return
  const executable = win32.join(
    process.env.SystemRoot || "C:\\Windows",
    "System32",
    "WindowsPowerShell",
    "v1.0",
    "powershell.exe",
  )
  const child = execFile(
    executable,
    ["-NoProfile", "-NonInteractive", "-Command", script],
    {
      windowsHide: true,
      timeout: 3000,
      maxBuffer: 64 * 1024,
      encoding: "utf8",
      env: { ...process.env, MC_LOG_CRASH_PIDS: pids.join(",") },
    },
    (error, stdout) => {
      try {
        if (error) {
          report({ type: "windows_crash_lookup", status: "unavailable" })
          return
        }
        const events = parseWindowsEvents(stdout, runs)
        report({
          type: "windows_crash_lookup",
          status: events.length ? "matched" : "no_match",
          events,
          note: "Faulting module is a correlation signal, not proof of root cause. Windows may not have recorded an event.",
        })
      } catch {}
    },
  )
  child.unref()
}
