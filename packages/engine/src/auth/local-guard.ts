import { timingSafeEqual } from "node:crypto"
import { isPidInTree, pidForPeer } from "./peer-pid"
import { currentPeer } from "./peer-context"

export type LocalAuthDecision = "ok" | "unauthorized" | "forbidden"

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

  const peer = currentPeer()
  const pid =
    peer && input.listenPort
      ? await pidForPeer({ localPort: input.listenPort, remoteAddr: peer.address, remotePort: peer.port }).catch(
          () => undefined,
        )
      : undefined
  if (input.engine && pid && pid !== input.engine && (await isPidInTree(pid, input.engine).catch(() => false)))
    return "forbidden"
  if (!input.parentPid || !risky(input.method, input.path)) return "ok"

  if (!pid) return "forbidden"
  return isPidInTree(pid, input.parentPid).then(
    (inTree) => (inTree ? "ok" : "forbidden"),
    () => "forbidden" as const,
  )
}
