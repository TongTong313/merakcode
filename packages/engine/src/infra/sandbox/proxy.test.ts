import { afterEach, beforeEach, describe, expect, test } from "vitest"
import http from "node:http"
import net, { type AddressInfo } from "node:net"
import { lookup as dns } from "node:dns/promises"
import { SandboxProxy } from "./proxy"

let target: http.Server
let targetPort: number
let proxy: SandboxProxy.Handle

const lookup = async (host: string) => (host.endsWith(".test") ? "127.0.0.1" : (await dns(host)).address)

beforeEach(async () => {
  target = http.createServer((req, res) => {
    res.setHeader("x-seen-proxy-auth", String(req.headers["proxy-authorization"] ?? "none"))
    res.end(`hello ${req.method} ${req.url} host=${req.headers.host}`)
  })
  await new Promise<void>((resolve) => target.listen(0, "127.0.0.1", resolve))
  targetPort = (target.address() as AddressInfo).port
  proxy = await SandboxProxy.start({ lookup })
})

afterEach(async () => {
  await proxy.close()
  await new Promise<void>((resolve) => target.close(() => resolve()))
})

const rules = (input: Partial<SandboxProxy.Rules> = {}): SandboxProxy.Rules => ({
  allow: ["allowed.test"],
  deny: ["denied.test"],
  blockPorts: [],
  ask: async () => false,
  ...input,
})

const auth = (owner: string) => `Basic ${Buffer.from(`${owner}:x`).toString("base64")}`

/** Sends raw bytes to the proxy and returns everything it answers until it closes or `until` shows up */
function raw(data: string, until?: string, after?: (socket: net.Socket, text: string) => void) {
  return new Promise<string>((resolve) => {
    const socket = net.connect(proxy.port, "127.0.0.1")
    let text = ""
    let sent = false
    socket.on("data", (chunk) => {
      text += chunk.toString()
      if (after && !sent && text.includes("\r\n\r\n")) {
        sent = true
        after(socket, text)
      }
      if (until && text.includes(until)) {
        socket.destroy()
        resolve(text)
      }
    })
    socket.on("close", () => resolve(text))
    socket.on("error", () => resolve(text))
    socket.write(data)
  })
}

function connect(host: string, port: number, owner?: string) {
  return raw(
    `CONNECT ${host}:${port} HTTP/1.1\r\nHost: ${host}:${port}\r\n${owner ? `Proxy-Authorization: ${auth(owner)}\r\n` : ""}\r\n`,
    "hello",
    (socket, text) => {
      if (text.startsWith("HTTP/1.1 200")) socket.write("GET /tunnel HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n")
    },
  )
}

function get(url: string, owner?: string, headers: Record<string, string> = {}) {
  return new Promise<{ status: number; body: string; headers: http.IncomingHttpHeaders }>((resolve, reject) => {
    const req = http.request(
      {
        host: "127.0.0.1",
        port: proxy.port,
        path: url,
        headers: { ...(owner ? { "proxy-authorization": auth(owner) } : {}), ...headers },
      },
      (res) => {
        let body = ""
        res.on("data", (chunk) => (body += chunk))
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body, headers: res.headers }))
      },
    )
    req.on("error", reject)
    req.end()
  })
}

describe("SandboxProxy", () => {
  test("CONNECT to an allowed host answers 200 and tunnels both ways", async () => {
    proxy.register("cmd1", rules())
    const text = await connect("allowed.test", targetPort, "cmd1")
    expect(text).toMatch(/^HTTP\/1\.1 200/)
    expect(text).toContain("hello GET /tunnel")
  })

  test("plain HTTP is forwarded by the host in the URL, without hop-by-hop headers", async () => {
    proxy.register("cmd1", rules())
    const result = await get(`http://allowed.test:${targetPort}/path?q=1`, "cmd1", { host: "denied.test" })
    expect(result.status).toBe(200)
    expect(result.body).toBe(`hello GET /path?q=1 host=allowed.test:${targetPort}`)
    expect(result.headers["x-seen-proxy-auth"]).toBe("none")
  })

  test("a denied host gets 403 with an explanation, and is listed as blocked", async () => {
    proxy.register("cmd1", rules())
    const result = await get(`http://denied.test:${targetPort}/`, "cmd1")
    expect(result.status).toBe(403)
    expect(result.body).toContain("blocked by MerakCode sandbox: denied.test")
    const tunnel = await connect("denied.test", targetPort, "cmd1")
    expect(tunnel).toMatch(/^HTTP\/1\.1 403/)
    expect(proxy.blocked("cmd1")).toEqual(["denied.test"])
  })

  test("an unknown host is asked about once; a yes is remembered for that command", async () => {
    const asked: SandboxProxy.Request[] = []
    proxy.register("cmd1", rules({ ask: async (req) => (asked.push(req), true) }))
    expect((await get(`http://new.test:${targetPort}/a`, "cmd1")).status).toBe(200)
    expect((await get(`http://new.test:${targetPort}/b`, "cmd1")).status).toBe(200)
    expect(asked).toEqual([{ host: "new.test", port: targetPort, owner: "cmd1" }])
  })

  test("an unknown host that is refused gets 403", async () => {
    proxy.register("cmd1", rules({ ask: async () => false }))
    expect((await get(`http://other.test:${targetPort}/`, "cmd1")).status).toBe(403)
    expect(proxy.blocked("cmd1")).toEqual(["other.test"])
  })

  test("deny wins over allow", async () => {
    proxy.register("cmd1", rules({ allow: ["both.test"], deny: ["both.test"] }))
    expect((await get(`http://both.test:${targetPort}/`, "cmd1")).status).toBe(403)
  })

  test("loopback is reachable except the blocked ports, also through a name that resolves there", async () => {
    proxy.register("cmd1", rules({ blockPorts: [targetPort] }))
    expect((await get(`http://127.0.0.1:${targetPort}/`, "cmd1")).status).toBe(403)
    expect((await get(`http://allowed.test:${targetPort}/`, "cmd1")).status).toBe(403)
    expect(await connect("localhost", targetPort, "cmd1")).toMatch(/^HTTP\/1\.1 403/)
    proxy.register("cmd2", rules({ blockPorts: [1] }))
    expect((await get(`http://127.0.0.1:${targetPort}/`, "cmd2")).status).toBe(200)
  })

  test("two commands at once: each question names its own command; no credentials means the newest", async () => {
    const asked: string[] = []
    const ask = async (req: SandboxProxy.Request) => (asked.push(`${req.owner}:${req.host}`), true)
    proxy.register("first", rules({ ask }))
    proxy.register("second", rules({ ask }))
    await get(`http://one.test:${targetPort}/`, "first")
    await get(`http://two.test:${targetPort}/`, "second")
    await get(`http://three.test:${targetPort}/`)
    expect(asked).toEqual(["first:one.test", "second:two.test", "second:three.test"])
  })

  test("a malformed request gets 400 and the proxy keeps working", async () => {
    proxy.register("cmd1", rules())
    expect(await raw("NOT A REQUEST\r\n\r\n")).toMatch(/^HTTP\/1\.1 400/)
    expect(await raw("GET /relative HTTP/1.1\r\nHost: x\r\n\r\n")).toMatch(/^HTTP\/1\.1 400/)
    expect((await get(`http://allowed.test:${targetPort}/`, "cmd1")).status).toBe(200)
  })

  test("no running command means everything is refused", async () => {
    expect((await get(`http://allowed.test:${targetPort}/`)).status).toBe(403)
  })

  test("close() stops listening and ends open tunnels", async () => {
    proxy.register("cmd1", rules())
    const socket = net.connect(proxy.port, "127.0.0.1")
    const closed = new Promise<void>((resolve) => socket.on("close", () => resolve()))
    socket.on("error", () => {})
    socket.write(`CONNECT allowed.test:${targetPort} HTTP/1.1\r\nProxy-Authorization: ${auth("cmd1")}\r\n\r\n`)
    await new Promise((resolve) => socket.once("data", resolve))
    await proxy.close()
    await closed
    await expect(get(`http://allowed.test:${targetPort}/`, "cmd1")).rejects.toThrow()
  })
})
