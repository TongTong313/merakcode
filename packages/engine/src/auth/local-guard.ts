import { timingSafeEqual } from "node:crypto"
import { setTimeout as sleep } from "node:timers/promises"
import { Log } from "@merakcode/log/logger"
import { isPidInTree, pidForPeer, refreshPeerLookup } from "./peer-pid"
import { currentPeer } from "./peer-context"

export type LocalAuthDecision = "ok" | "unauthorized" | "forbidden"

const log = Log.create({ service: "auth.guard" })

/**
 * The connection table and the Windows process snapshot are cached briefly and can miss a connection or a process
 * that has only just appeared, so a peer that cannot be placed in the desktop process tree is looked up again before
 * the request is refused
 */
const ATTEMPTS = 3
const RETRY_MS = 100

function parseBasic(header: string | null): { username: string; password: string } | undefined {
  const match = header ? /^Basic\s+(\S+)/i.exec(header.trim()) : null
  if (!match) return
  const decoded = Buffer.from(match[1], "base64").toString("utf8")
  const idx = decoded.indexOf(":")
  if (idx < 0) return
  return { username: decoded.slice(0, idx), password: decoded.slice(idx + 1) }
}

function safeEqual(left: string, right: string): boolean {
  const a = Buffer.from(left)
  const b = Buffer.from(right)
  return a.length === b.length && timingSafeEqual(a, b)
}

/**
 * Risky endpoints: terminals and commands, MCP installs, credential writes, config changes (config can add MCP
 * commands) and provider changes. When the desktop main process PID is set, these endpoints only accept requests
 * from that process tree, so a password leaked to another process is not enough.
 */
function risky(method: string, path: string): boolean {
  const raw = path.split("?")[0] ?? ""
  const normalized = (raw.startsWith("/") ? raw : `/${raw}`).replace(/\/+$/, "") || "/"
  const under = (prefix: string) => normalized === prefix || normalized.startsWith(`${prefix}/`)
  if (["/pty", "/bash", "/mcp", "/mcp-management", "/auth", "/global/config"].some(under)) return true
  const write = method !== "GET" && method !== "HEAD"
  // Setting the sandbox up or resetting it creates or deletes a Windows account and changes folder permissions
  return write && (under("/provider") || under("/config") || under("/sandbox"))
}

/** Endpoints a command started by the engine itself must never reach: risky ones plus approval and question replies */
function guarded(method: string, path: string): boolean {
  if (risky(method, path)) return true
  if (method === "GET" || method === "HEAD") return false
  const raw = path.split("?")[0] ?? ""
  return /^\/?(permission|question)(\/|$)/.test(raw)
}

/** Authorizes requests to the local engine: Basic password, plus a process tree check for risky endpoints */
export async function authorizeLocalRequest(input: {
  method: string
  path: string
  headers: Headers
  secret: string
  username: string
  parentPid?: number
  /** The engine's own pid: requests from its descendants (agent-run commands) are refused on guarded endpoints */
  engine?: number
  listenPort?: number
}): Promise<LocalAuthDecision> {
  const basic = parseBasic(input.headers.get("authorization"))
  if (!basic || !safeEqual(basic.username, input.username) || !safeEqual(basic.password, input.secret))
    return "unauthorized"
  if (!guarded(input.method, input.path)) return "ok"

  for (let attempt = 1; ; attempt++) {
    const verdict = await judge(input)
    if (verdict.result === "ok") return "ok"
    // A child of the engine was identified for certain; only an unplaced peer is worth another look
    if (verdict.reason === "engine child" || attempt >= ATTEMPTS) {
      log.warn("refused guarded request", {
        method: input.method,
        path: input.path,
        reason: verdict.reason,
        pid: verdict.pid,
      })
      return "forbidden"
    }
    refreshPeerLookup()
    await sleep(RETRY_MS)
  }
}

type Verdict =
  | { result: "ok" }
  | { result: "forbidden"; reason: "engine child" | "unknown peer" | "outside desktop tree"; pid?: number }

async function judge(input: Parameters<typeof authorizeLocalRequest>[0]): Promise<Verdict> {
  const peer = currentPeer()
  const pid =
    peer && input.listenPort
      ? await pidForPeer({ localPort: input.listenPort, remoteAddr: peer.address, remotePort: peer.port }).catch(
          () => undefined,
        )
      : undefined
  if (input.engine && pid && pid !== input.engine && (await isPidInTree(pid, input.engine).catch(() => false)))
    return { result: "forbidden", reason: "engine child", pid }
  if (!input.parentPid || !risky(input.method, input.path)) return { result: "ok" }

  if (!pid) return { result: "forbidden", reason: "unknown peer" }
  const inTree = await isPidInTree(pid, input.parentPid).catch(() => false)
  return inTree ? { result: "ok" } : { result: "forbidden", reason: "outside desktop tree", pid }
}
