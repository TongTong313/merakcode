// Deliberately standalone: copied beside the npm launcher, and bundled into desktop.
const fs = require("node:fs")
const path = require("node:path")
const os = require("node:os")

function safe(value) {
  return (
    String(value)
      .replace(/[^a-zA-Z0-9_-]/g, "-")
      .slice(0, 80) || "unknown"
  )
}

function root() {
  if (process.env.MERAKCODE_LOG_ROOT) return process.env.MERAKCODE_LOG_ROOT.replaceAll("\0", "")
  return path.join(process.env.XDG_DATA_HOME || path.join(os.homedir(), ".local", "share"), "merakcode", "log")
}

// Only extracted, bounded identifiers reach disk. Never persist arbitrary stderr, argv, URLs or report payloads.
function nativeEvidence(text) {
  // Node/V8 fatal errors: heap exhaustion, failed V8 checks, and the native stack trace printed with them
  const runtime = /FATAL ERROR:|# Fatal error in|Native stack trace/.test(text)
  const native = /segmentation fault|access violation/i.test(text)
  return {
    runtime_crash_signature: runtime,
    native_fault_signature: native,
    runtime_version: text.match(/Node\.js v(\d+\.\d+\.\d+(?:-[a-zA-Z0-9.]+)?)/)?.[1],
    fault_address: text.match(/(?:fault at address|access violation at)\s+(0x[0-9a-f]+)/i)?.[1],
    modules_observed:
      runtime || native ? [...new Set(text.match(/[A-Za-z0-9_.-]{1,120}\.(?:dll|node)\b/gi) || [])].slice(0, 30) : [],
  }
}

class CrashEvidence {
  constructor(options) {
    const dir = path.join(options.root || root(), ".state", "crash-evidence")
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
    this.file = path.join(dir, `${safe(options.component)}-${safe(options.runId)}.json`)
    this.tail = ""
    this.closed = false
    this.data = {
      schema: "merakcode.crash-evidence.v3",
      owner_pid: process.pid,
      component: safe(options.component),
      run_id: safe(options.runId),
      started_at: new Date().toISOString(),
      evidence: nativeEvidence(""),
    }
    this.save()
  }

  save() {
    fs.writeFileSync(this.file, JSON.stringify(this.data), { mode: 0o600 })
  }

  write(chunk) {
    if (this.closed) return 0
    try {
      // Process bounded windows even if a caller hands us a very large chunk.
      const value = typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8")
      for (let offset = 0; offset < value.length; offset += 8192) {
        this.tail = (this.tail + value.slice(offset, offset + 8192)).slice(-32768)
        const next = nativeEvidence(this.tail)
        const previous = this.data.evidence
        this.data.evidence = {
          ...previous,
          runtime_crash_signature: previous.runtime_crash_signature || next.runtime_crash_signature,
          native_fault_signature: previous.native_fault_signature || next.native_fault_signature,
          runtime_version: next.runtime_version || previous.runtime_version,
          fault_address: next.fault_address || previous.fault_address,
          modules_observed: [...new Set([...previous.modules_observed, ...next.modules_observed])].slice(0, 30),
        }
      }
      if (this.data.evidence.runtime_crash_signature || this.data.evidence.native_fault_signature) this.save()
      return value.length
    } catch {
      return 0
    }
  }

  close(options = {}) {
    if (this.closed) return
    this.closed = true
    this.tail = ""
    try {
      if (!options.keep) {
        fs.rmSync(this.file, { force: true })
        return
      }
      this.data.owner_pid = 0
      this.data.exit_code = options.code ?? null
      this.data.signal = options.signal ?? null
      this.save()
    } catch {}
  }
}

module.exports = { CrashEvidence, nativeEvidence }
