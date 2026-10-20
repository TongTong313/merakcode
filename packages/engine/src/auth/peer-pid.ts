import { execFile } from "node:child_process"
import { existsSync, readdirSync, readFileSync, readlinkSync } from "node:fs"
import { join } from "node:path"
import { promisify } from "node:util"
import { native } from "@merakcode/util/ffi"

const execFileAsync = promisify(execFile)
const OWNER_CACHE_MS = 400
const WINDOWS_PARENT_MAP_CACHE_MS = 2_000
const WINDOWS_CIM_TIMEOUT_MS = 8_000
const EXEC_MAX_BUFFER = 8 * 1024 * 1024

export type TcpOwner = {
  localAddr: string
  localPort: number
  remoteAddr: string
  remotePort: number
  pid: number
}

export type PeerPidLookup = {
  owners(): Promise<TcpOwner[]>
  parentPid(pid: number): Promise<number | undefined>
}

let lookup: PeerPidLookup = platformLookup()
let ownerCache: { at: number; owners: TcpOwner[] } | undefined
let windowsParentMapCache: { at: number; map: Map<number, number> } | undefined
const parentCache = new Map<number, number | undefined>()

export function setPeerPidLookupForTest(next: PeerPidLookup | undefined): void {
  lookup = next ?? platformLookup()
  ownerCache = undefined
  windowsParentMapCache = undefined
  parentCache.clear()
}

export async function pidForPeer(input: {
  localPort: number
  remoteAddr: string
  remotePort: number
}): Promise<number | undefined> {
  const pid = pidFromTcpOwners(await cachedOwners(), input)
  if (pid) return pid
  ownerCache = undefined
  return pidFromTcpOwners(await cachedOwners(), input)
}

/**
 * A loopback connection has two rows: the server side PID is the engine, the client side PID is Electron. Prefer the
 * client side.
 */
export function pidFromTcpOwners(
  owners: TcpOwner[],
  input: { localPort: number; remoteAddr: string; remotePort: number },
): number | undefined {
  const remote = normalizeAddr(input.remoteAddr)
  const client = owners.find(
    (row) =>
      row.localPort === input.remotePort &&
      row.remotePort === input.localPort &&
      addrsCompatible(row.localAddr, remote),
  )
  if (client?.pid && client.pid > 0) return client.pid
  const server = owners.find(
    (row) =>
      row.localPort === input.localPort &&
      row.remotePort === input.remotePort &&
      addrsCompatible(row.remoteAddr, remote),
  )
  return server?.pid && server.pid > 0 ? server.pid : undefined
}

export async function isPidInTree(pid: number | undefined, rootPid: number): Promise<boolean> {
  if (!pid || pid <= 0 || rootPid <= 0) return false
  const seen = new Set<number>()
  let current = pid
  for (let i = 0; i < 32; i++) {
    if (current === rootPid) return true
    if (seen.has(current)) return false
    seen.add(current)
    const parent = await cachedParent(current)
    if (!parent || parent <= 0) return false
    current = parent
  }
  return false
}

async function cachedOwners(): Promise<TcpOwner[]> {
  const now = Date.now()
  if (ownerCache && now - ownerCache.at < OWNER_CACHE_MS) return ownerCache.owners
  try {
    const owners = await lookup.owners()
    ownerCache = { at: now, owners }
    return owners
  } catch {
    return ownerCache?.owners ?? []
  }
}

async function cachedParent(pid: number): Promise<number | undefined> {
  if (parentCache.has(pid)) return parentCache.get(pid)
  try {
    const parent = await lookup.parentPid(pid)
    if (parent && parent > 0) parentCache.set(pid, parent)
    return parent
  } catch {
    return undefined
  }
}

function platformLookup(): PeerPidLookup {
  if (process.platform === "win32") return windowsLookup()
  if (process.platform === "linux") return linuxLookup()
  return darwinLookup()
}

function windowsLookup(): PeerPidLookup {
  return {
    async owners() {
      const stdout = await execUtf8("netstat", ["-ano", "-p", "tcp"], 2_000)
      return stdout ? parseNetstat(stdout) : []
    },
    async parentPid(pid) {
      const map = await cachedWindowsParentMap()
      return map.get(pid)
    },
  }
}

/**
 * Windows 11 may not ship WMIC.exe at all. Prefer a Toolhelp snapshot (no spawn), then fall back to WMIC / CIM.
 * An empty map is not cached, so a single timeout does not make every later PTY request fail with 403.
 */
async function cachedWindowsParentMap(): Promise<Map<number, number>> {
  const now = Date.now()
  if (windowsParentMapCache && now - windowsParentMapCache.at < WINDOWS_PARENT_MAP_CACHE_MS) {
    return windowsParentMapCache.map
  }
  const map = await loadWindowsParentMap()
  if (map.size > 0) windowsParentMapCache = { at: now, map }
  return map
}

async function loadWindowsParentMap(): Promise<Map<number, number>> {
  const fromToolhelp = readWindowsParentMapFromToolhelp()
  if (fromToolhelp.size > 0) return fromToolhelp
  const fromWmic = await readWindowsParentMapFromWmic()
  if (fromWmic.size > 0) return fromWmic
  return readWindowsParentMapFromCim()
}

/** CreateToolhelp32Snapshot + Process32First/NextW: takes milliseconds and does not depend on wmic or PowerShell. */
export function readWindowsParentMapFromToolhelp(): Map<number, number> {
  const lib = native()
  if (!lib || process.platform !== "win32") return new Map()
  try {
    const kernel32 = {
      CreateToolhelp32Snapshot: (flags: number, pid: number) =>
        lib.call("kernel32.dll", "CreateToolhelp32Snapshot", ["u32", "u32"], "ptr", [flags, pid]),
      Process32FirstW: (snap: bigint | number, entry: Buffer) =>
        lib.call("kernel32.dll", "Process32FirstW", ["ptr", "ptr"], "i32", [snap, lib.pointer(entry)]),
      Process32NextW: (snap: bigint | number, entry: Buffer) =>
        lib.call("kernel32.dll", "Process32NextW", ["ptr", "ptr"], "i32", [snap, lib.pointer(entry)]),
      CloseHandle: (snap: bigint | number) => lib.call("kernel32.dll", "CloseHandle", ["ptr"], "i32", [snap]),
    }
    const layout = process.arch === "ia32" ? { dwSize: 556, pid: 8, ppid: 24 } : { dwSize: 568, pid: 8, ppid: 32 }
    const entry = Buffer.alloc(layout.dwSize)
    entry.writeUInt32LE(layout.dwSize, 0)
    const snap = kernel32.CreateToolhelp32Snapshot(0x00000002, 0)
    // INVALID_HANDLE_VALUE is -1, which reads back as all ones when unsigned
    if (!snap || Number(snap) <= 0 || BigInt(snap) === 0xffffffffffffffffn) return new Map()
    const map = new Map<number, number>()
    try {
      let ok = kernel32.Process32FirstW(snap, entry)
      while (ok) {
        const pid = entry.readUInt32LE(layout.pid)
        const ppid = entry.readUInt32LE(layout.ppid)
        if (pid > 0) map.set(pid, ppid)
        ok = kernel32.Process32NextW(snap, entry)
      }
    } finally {
      kernel32.CloseHandle(snap)
    }
    return map
  } catch {
    return new Map()
  }
}

async function readWindowsParentMapFromWmic(): Promise<Map<number, number>> {
  const wmic = windowsToolPath("System32", "wbem", "WMIC.exe")
  if (!wmic) return new Map()
  const stdout = await execUtf8(wmic, ["process", "get", "ProcessId,ParentProcessId", "/VALUE"], 2_000)
  return stdout ? parseWmicValueParents(stdout) : new Map()
}

async function readWindowsParentMapFromCim(): Promise<Map<number, number>> {
  const powershell = windowsToolPath("System32", "WindowsPowerShell", "v1.0", "powershell.exe")
  if (!powershell) return new Map()
  const stdout = await execUtf8(
    powershell,
    [
      "-NoProfile",
      "-NonInteractive",
      "-NoLogo",
      "-Command",
      "Get-CimInstance -ClassName Win32_Process | ForEach-Object { '{0}={1}' -f $_.ProcessId, $_.ParentProcessId }",
    ],
    WINDOWS_CIM_TIMEOUT_MS,
  )
  return stdout ? parsePidEqParentLines(stdout) : new Map()
}

function windowsToolPath(...segments: string[]): string | undefined {
  const root = process.env.SystemRoot || process.env.WINDIR || "C:\\Windows"
  const candidate = join(root, ...segments)
  return existsSync(candidate) ? candidate : undefined
}

async function execUtf8(file: string, args: string[], timeout: number): Promise<string | undefined> {
  try {
    const { stdout } = await execFileAsync(file, args, {
      windowsHide: true,
      timeout,
      encoding: "utf8",
      maxBuffer: EXEC_MAX_BUFFER,
    })
    return typeof stdout === "string" ? stdout : String(stdout)
  } catch {
    return undefined
  }
}

/** WMIC `/VALUE` records are separated by blank lines; field order is not fixed. */
export function parseWmicValueParents(stdout: string): Map<number, number> {
  const map = new Map<number, number>()
  for (const record of stdout.split(/\r?\n\r?\n/)) {
    const pid = record.match(/^\s*ProcessId=(\d+)\s*$/im)?.[1]
    const ppid = record.match(/^\s*ParentProcessId=(\d+)\s*$/im)?.[1]
    if (!pid || !ppid) continue
    map.set(Number(pid), Number(ppid))
  }
  return map
}

/** CIM output: one `pid=ppid` per line. */
export function parsePidEqParentLines(stdout: string): Map<number, number> {
  const map = new Map<number, number>()
  for (const line of stdout.split(/\r?\n/)) {
    const match = line.trim().match(/^(\d+)=(\d+)$/)
    if (!match) continue
    map.set(Number(match[1]), Number(match[2]))
  }
  return map
}

function linuxLookup(): PeerPidLookup {
  return {
    async owners() {
      return ownersFromProcNet("/proc/net/tcp", false).concat(ownersFromProcNet("/proc/net/tcp6", true))
    },
    async parentPid(pid) {
      try {
        const stat = readFileSync(`/proc/${pid}/stat`, "utf8")
        const close = stat.lastIndexOf(")")
        const rest = stat.slice(close + 2).split(" ")
        const ppid = Number(rest[1])
        return Number.isInteger(ppid) ? ppid : undefined
      } catch {
        return undefined
      }
    },
  }
}

function darwinLookup(): PeerPidLookup {
  return {
    async owners() {
      const { stdout } = await execFileAsync("lsof", ["-nP", "-iTCP", "-sTCP:ESTABLISHED"], { timeout: 2_000 })
      return parseLsof(stdout)
    },
    async parentPid(pid) {
      const { stdout } = await execFileAsync("ps", ["-o", "ppid=", "-p", String(pid)], { timeout: 2_000 })
      const n = Number(stdout.trim())
      return Number.isInteger(n) ? n : undefined
    },
  }
}

export function parseNetstat(stdout: string): TcpOwner[] {
  const rows: TcpOwner[] = []
  for (const line of stdout.split(/\r?\n/)) {
    const match = line.match(/^\s*TCP\s+(\S+):(\d+)\s+(\S+):(\d+)\s+ESTABLISHED\s+(\d+)\s*$/i)
    if (!match) continue
    rows.push({
      localAddr: stripBrackets(match[1]),
      localPort: Number(match[2]),
      remoteAddr: stripBrackets(match[3]),
      remotePort: Number(match[4]),
      pid: Number(match[5]),
    })
  }
  return rows
}

export function parseLsof(stdout: string): TcpOwner[] {
  const rows: TcpOwner[] = []
  // On macOS the last lsof column is often (ESTABLISHED) and NAME is second to last, so the last column won't do.
  const nameRe = /^(?:\[?([^\s\]]+)\]?)?:(\d+)->(?:\[?([^\s\]]+)\]?)?:(\d+)$/
  for (const line of stdout.split(/\r?\n/).slice(1)) {
    const cols = line.trim().split(/\s+/)
    if (cols.length < 9) continue
    const pid = Number(cols[1])
    if (!Number.isInteger(pid) || pid <= 0) continue
    const name = cols.find((col) => nameRe.test(col))
    if (!name) continue
    const match = name.match(nameRe)
    if (!match) continue
    rows.push({
      localAddr: match[1],
      localPort: Number(match[2]),
      remoteAddr: match[3],
      remotePort: Number(match[4]),
      pid,
    })
  }
  return rows
}

function ownersFromProcNet(file: string, ipv6: boolean): TcpOwner[] {
  let text: string
  try {
    text = readFileSync(file, "utf8")
  } catch {
    return []
  }
  const rows: TcpOwner[] = []
  const inodePid = inodeToPid()
  for (const line of text.split("\n").slice(1)) {
    const cols = line.trim().split(/\s+/)
    if (cols.length < 10) continue
    if (cols[3] !== "01") continue
    const local = parseProcAddr(cols[1], ipv6)
    const remote = parseProcAddr(cols[2], ipv6)
    const inode = cols[9]
    const pid = inodePid.get(inode)
    if (!local || !remote || !pid) continue
    rows.push({
      localAddr: local.addr,
      localPort: local.port,
      remoteAddr: remote.addr,
      remotePort: remote.port,
      pid,
    })
  }
  return rows
}

function parseProcAddr(field: string, ipv6: boolean): { addr: string; port: number } | undefined {
  const [ipHex, portHex] = field.split(":")
  if (!ipHex || !portHex) return
  const port = Number.parseInt(portHex, 16)
  const addr = ipv6 ? hexToIpv6(ipHex) : hexToIpv4(ipHex)
  if (!addr || !Number.isInteger(port)) return
  return { addr, port }
}

function hexToIpv4(hex: string): string | undefined {
  if (hex.length !== 8) return
  const n = Number.parseInt(hex, 16)
  if (!Number.isFinite(n)) return
  return `${n & 0xff}.${(n >> 8) & 0xff}.${(n >> 16) & 0xff}.${(n >> 24) & 0xff}`
}

function hexToIpv6(hex: string): string | undefined {
  if (hex.length !== 32) return
  const parts: string[] = []
  for (let i = 0; i < 32; i += 4) parts.push(hex.slice(i, i + 4))
  return parts.join(":")
}

function inodeToPid(): Map<string, number> {
  const map = new Map<string, number>()
  let pids: string[]
  try {
    pids = readdirSync("/proc")
  } catch {
    return map
  }
  for (const pid of pids) {
    if (!/^\d+$/.test(pid)) continue
    let fds: string[]
    try {
      fds = readdirSync(`/proc/${pid}/fd`)
    } catch {
      continue
    }
    for (const fd of fds) {
      try {
        const link = readlinkSync(`/proc/${pid}/fd/${fd}`)
        const match = link.match(/^socket:\[(\d+)\]$/)
        if (match) map.set(match[1], Number(pid))
      } catch {
        // skip
      }
    }
  }
  return map
}

function stripBrackets(host: string): string {
  return host.replace(/^\[|\]$/g, "")
}

function normalizeAddr(addr: string): string {
  const host = stripBrackets(addr).toLowerCase()
  if (host === "::ffff:127.0.0.1") return "127.0.0.1"
  if (host === "0:0:0:0:0:0:0:1") return "::1"
  return host
}

function isLoopback(addr: string): boolean {
  const host = normalizeAddr(addr)
  return host === "127.0.0.1" || host === "::1" || host === "localhost"
}

function addrsCompatible(left: string, right: string): boolean {
  const a = normalizeAddr(left)
  const b = normalizeAddr(right)
  if (a === b) return true
  return isLoopback(a) && isLoopback(b)
}
