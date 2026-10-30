/**
 * The only way out to the network for sandboxed commands: a local HTTP proxy that also tunnels HTTPS (CONNECT).
 * Each running command registers as an owner and sends its name as the proxy user name, so questions about unknown
 * hosts reach the session that started the command. Decisions use the host from the request line, never the Host
 * header, and loopback addresses are checked again after name resolution.
 */
import http from "node:http"
import net from "node:net"
import { lookup as dns } from "node:dns/promises"
import { Domain } from "./domain"

export namespace SandboxProxy {
  export type Request = { host: string; port: number; owner: string }
  export type Rules = {
    allow: string[]
    deny: string[]
    /** Loopback ports that stay unreachable, e.g. the engine's own */
    blockPorts: number[]
    /** Asked once per host and command for hosts that are neither allowed nor denied */
    ask: (req: Request) => Promise<boolean>
  }
  export type Handle = {
    port: number
    /** Proxy URL a command uses; the owner travels as the user name */
    url(owner: string): string
    register(owner: string, rules: Rules): void
    unregister(owner: string): void
    /** Hosts refused for this owner, in the order they were first refused */
    blocked(owner: string): string[]
    close(): Promise<void>
  }

  type Entry = { rules: Rules; answers: Map<string, Promise<boolean>>; blocked: Set<string> }
  type Verdict = { ok: true; address: string } | { ok: false; status: 403 | 502 }

  const HOP = new Set([
    "connection",
    "keep-alive",
    "proxy-authenticate",
    "proxy-authorization",
    "proxy-connection",
    "te",
    "trailer",
    "transfer-encoding",
    "upgrade",
  ])

  function strip(headers: http.IncomingHttpHeaders) {
    const listed = new Set(
      String(headers.connection ?? "")
        .split(",")
        .map((name) => name.trim().toLowerCase())
        .filter(Boolean),
    )
    return Object.fromEntries(
      Object.entries(headers).filter(([key, value]) => value !== undefined && !HOP.has(key) && !listed.has(key)),
    ) as http.OutgoingHttpHeaders
  }

  function user(header: string | undefined) {
    if (!header?.startsWith("Basic ")) return
    return Buffer.from(header.slice(6), "base64").toString().split(":")[0] || undefined
  }

  const message = (host: string) => `blocked by MerakCode sandbox: ${host}\n`

  export async function start(options: { lookup?: (host: string) => Promise<string> } = {}): Promise<Handle> {
    const lookup = options.lookup ?? (async (host: string) => (await dns(host)).address)
    const owners = new Map<string, Entry>()
    const sockets = new Set<net.Socket>()
    const track = (socket: net.Socket) => {
      sockets.add(socket)
      socket.on("close", () => sockets.delete(socket))
      socket.on("error", () => {})
    }

    const ownerOf = (header: string | undefined) => {
      const named = user(header)
      if (named) return owners.has(named) ? named : undefined
      return [...owners.keys()].at(-1)
    }

    async function decide(owner: string | undefined, target: string, port: number): Promise<Verdict> {
      const entry = owner ? owners.get(owner) : undefined
      if (!owner || !entry) return { ok: false, status: 403 }
      const host = target.replace(/^\[(.*)\]$/, "$1").toLowerCase()
      const refuse = (): Verdict => {
        entry.blocked.add(host)
        return { ok: false, status: 403 }
      }
      if (Domain.loopback(host)) {
        if (entry.rules.blockPorts.includes(port)) return refuse()
        return { ok: true, address: host === "localhost" || host.endsWith(".localhost") ? "127.0.0.1" : host }
      }
      if (entry.rules.deny.some((pattern) => Domain.matches(pattern, host, port, "deny"))) return refuse()
      if (!entry.rules.allow.some((pattern) => Domain.matches(pattern, host, port))) {
        const answer = entry.answers.get(host) ?? entry.rules.ask({ host, port, owner }).catch(() => false as boolean)
        entry.answers.set(host, answer)
        if (!(await answer)) return refuse()
      }
      const address = await lookup(host).catch(() => undefined)
      if (!address) return { ok: false, status: 502 }
      if (Domain.loopback(address) && entry.rules.blockPorts.includes(port)) return refuse()
      return { ok: true, address }
    }

    const server = http.createServer(async (req, res) => {
      const url = (() => {
        try {
          return new URL(req.url ?? "")
        } catch {
          return undefined
        }
      })()
      if (!url || url.protocol !== "http:") {
        res.writeHead(400, { "content-type": "text/plain", connection: "close" }).end("not a proxy request\n")
        return
      }
      const port = Number(url.port || 80)
      const verdict = await decide(ownerOf(req.headers["proxy-authorization"]), url.hostname, port)
      if (!verdict.ok) {
        res.writeHead(verdict.status, { "content-type": "text/plain" }).end(message(url.hostname))
        return
      }
      const upstream = http.request(
        {
          host: verdict.address,
          port,
          method: req.method,
          path: url.pathname + url.search,
          headers: { ...strip(req.headers), host: url.host },
          agent: false,
        },
        (reply) => {
          res.writeHead(reply.statusCode ?? 502, strip(reply.headers))
          reply.pipe(res)
        },
      )
      upstream.on("socket", track)
      upstream.on("error", () => {
        if (!res.headersSent) res.writeHead(502, { "content-type": "text/plain" })
        res.end()
      })
      req.pipe(upstream)
    })

    server.on("connection", track)
    server.on("clientError", (_error, socket) => {
      if (socket.writable) socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n")
      else socket.destroy()
    })

    server.on("connect", async (req: http.IncomingMessage, client: net.Socket, head: Buffer) => {
      const match = /^(\[[^\]]+\]|[^:]+):(\d+)$/.exec(req.url ?? "")
      if (!match) {
        client.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n")
        return
      }
      const [host, port] = [match[1]!, Number(match[2])]
      const verdict = await decide(ownerOf(req.headers["proxy-authorization"]), host, port)
      if (!verdict.ok) {
        const body = message(host)
        const reason = verdict.status === 403 ? "Forbidden" : "Bad Gateway"
        client.end(
          `HTTP/1.1 ${verdict.status} ${reason}\r\nContent-Type: text/plain\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`,
        )
        return
      }
      const upstream = net.connect(port, verdict.address)
      track(upstream)
      let open = false
      upstream.on("connect", () => {
        open = true
        client.write("HTTP/1.1 200 Connection Established\r\n\r\n")
        if (head.length) upstream.write(head)
        upstream.pipe(client)
        client.pipe(upstream)
      })
      upstream.on("error", () => {
        if (open) client.destroy()
        else client.end("HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n")
      })
      client.on("close", () => upstream.destroy())
    })

    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
    const port = (server.address() as net.AddressInfo).port

    return {
      port,
      url: (owner) => `http://${encodeURIComponent(owner)}:x@127.0.0.1:${port}`,
      register: (owner, rules) => {
        owners.delete(owner)
        owners.set(owner, { rules, answers: new Map(), blocked: new Set() })
      },
      unregister: (owner) => void owners.delete(owner),
      blocked: (owner) => [...(owners.get(owner)?.blocked ?? [])],
      close: () =>
        new Promise<void>((resolve) => {
          server.close(() => resolve())
          for (const socket of sockets) socket.destroy()
          server.closeAllConnections()
        }),
    }
  }
}
