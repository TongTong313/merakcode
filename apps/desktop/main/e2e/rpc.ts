/**
 * The desktop talks to the engine over one WebSocket carrying JSON-RPC. This proxy sits between the page and the
 * engine so a spec can observe calls, hold them, fail them before the engine sees them, or lose their answers.
 */
import { readFile } from "node:fs/promises"
import path from "node:path"
import type { Page } from "@playwright/test"

export type RpcCall = { id: number; method: string; params: Record<string, unknown> }
type Match = (params: Record<string, unknown>) => boolean

export type Hold = {
  /** Calls that arrived and wait for release() */
  calls: RpcCall[]
  /** Settles when the first matching call arrives */
  entered: Promise<RpcCall>
  /** Lets the waiting calls, and every later one, through */
  release: () => void
}

type Rule = { method: string; match?: Match; times: number; kind: "fail" | "lose"; code?: string }
type Delay = {
  method: string
  match?: Match
  times: number
  hold: Hold
  gate: Promise<void>
  entered: (call: RpcCall) => void
}

export class Rpc {
  readonly calls: RpcCall[] = []
  private holds: {
    method: string
    match?: Match
    times: number
    hold: Hold
    gate: Promise<void>
    entered: (call: RpcCall) => void
  }[] = []
  private rules: Rule[] = []
  private delays: Delay[] = []

  /** Every call of a method seen so far, newest last. */
  seen(method: string, match?: Match) {
    return this.calls.filter((call) => call.method === method && (!match || match(call.params)))
  }

  /** Holds matching calls before the engine sees them, until release(); only the first `times` calls are held. */
  hold(method: string, options: { match?: Match; times?: number } = {}): Hold {
    const gate = Promise.withResolvers<void>()
    const entered = Promise.withResolvers<RpcCall>()
    const hold: Hold = { calls: [], entered: entered.promise, release: () => gate.resolve() }
    this.holds.push({
      method,
      match: options.match,
      times: options.times ?? Infinity,
      hold,
      gate: gate.promise,
      entered: entered.resolve,
    })
    return hold
  }

  /** Answers matching calls with an error carrying the code, without asking the engine. */
  fail(method: string, code: string, options: { match?: Match; times?: number } = {}) {
    this.rules.push({ method, match: options.match, times: options.times ?? 1, kind: "fail", code })
  }

  /** Lets matching calls run in the engine but delays the answer until release(); entered settles when it arrives. */
  holdResponse(method: string, options: { match?: Match; times?: number } = {}): Hold {
    const gate = Promise.withResolvers<void>()
    const entered = Promise.withResolvers<RpcCall>()
    const hold: Hold = { calls: [], entered: entered.promise, release: () => gate.resolve() }
    this.delays.push({
      method,
      match: options.match,
      times: options.times ?? 1,
      hold,
      gate: gate.promise,
      entered: entered.resolve,
    })
    return hold
  }

  /** @internal */
  delay(call: RpcCall) {
    const item = this.delays.find(
      (value) => value.method === call.method && value.times > 0 && (!value.match || value.match(call.params)),
    )
    if (!item) return
    item.times--
    return item
  }

  /** Lets matching calls run in the engine but replaces the answer with a connection error. */
  loseResponse(method: string, options: { match?: Match; times?: number } = {}) {
    this.rules.push({ method, match: options.match, times: options.times ?? 1, kind: "lose" })
  }

  /** @internal */
  async before(call: RpcCall) {
    this.calls.push(call)
    for (const item of this.holds) {
      if (item.method !== call.method || item.times <= 0 || (item.match && !item.match(call.params))) continue
      item.times--
      item.hold.calls.push(call)
      item.entered(call)
      await item.gate
      // One call is held by one hold: a later hold takes the next call
      break
    }
  }

  /** @internal */
  take(call: RpcCall, kind: Rule["kind"]) {
    const rule = this.rules.find(
      (item) =>
        item.kind === kind && item.times > 0 && item.method === call.method && (!item.match || item.match(call.params)),
    )
    if (!rule) return
    rule.times--
    return rule
  }
}

/** Puts the proxy in front of the page's engine connection; reload the page so it opens its connection through it. */
export async function installRpc(page: Page, root: string) {
  const rpc = new Rpc()
  const info = JSON.parse(await readFile(path.join(root, "data", "engine.json"), "utf8")) as { token: string }
  await page.routeWebSocket(
    (url) => url.pathname === "/rpc",
    (socket) => {
      const origin = new URL(socket.url())
      origin.protocol = "http:"
      const NodeWebSocket = WebSocket as typeof WebSocket & {
        new (url: string, options: { headers: Record<string, string> }): WebSocket
      }
      const server = new NodeWebSocket(socket.url(), {
        headers: { Authorization: `Bearer ${info.token}`, Origin: origin.origin },
      })
      const open = new Promise<void>((resolve) => server.addEventListener("open", () => resolve(), { once: true }))
      const lost = new Set<number>()
      const delayed = new Map<number, { call: RpcCall; item: Delay }>()
      let queue = Promise.resolve()
      socket.onMessage((message) => {
        // Messages are forwarded in the order they arrived, but a held call does not block the ones behind it.
        const text = typeof message === "string" ? message : message.toString()
        const call = (() => {
          try {
            const value = JSON.parse(text) as { id?: number; method?: string; params?: Record<string, unknown> }
            return typeof value.id === "number" && typeof value.method === "string"
              ? ({ id: value.id, method: value.method, params: value.params ?? {} } satisfies RpcCall)
              : undefined
          } catch {
            return undefined
          }
        })()
        queue = queue.then(() => open)
        void queue.then(async () => {
          if (!call) return server.send(text)
          await rpc.before(call)
          const failure = rpc.take(call, "fail")
          if (failure) {
            socket.send(
              JSON.stringify({
                jsonrpc: "2.0",
                id: call.id,
                error: { code: -32000, message: failure.code, data: { code: failure.code } },
              }),
            )
            return
          }
          if (rpc.take(call, "lose")) lost.add(call.id)
          const item = rpc.delay(call)
          if (item) delayed.set(call.id, { call, item })
          server.send(text)
        })
      })
      server.addEventListener("message", (event) => {
        const data = typeof event.data === "string" ? event.data : String(event.data)
        try {
          const value = JSON.parse(data) as { id?: number; method?: string }
          const slow = typeof value.id === "number" && value.method === undefined ? delayed.get(value.id) : undefined
          if (slow) {
            delayed.delete(value.id!)
            slow.item.hold.calls.push(slow.call)
            slow.item.entered(slow.call)
            void slow.item.gate.then(() => socket.send(data))
            return
          }
          if (typeof value.id === "number" && value.method === undefined && lost.delete(value.id)) {
            socket.send(
              JSON.stringify({
                jsonrpc: "2.0",
                id: value.id,
                error: { code: -32000, message: "MRK-1001", data: { code: "MRK-1001" } },
              }),
            )
            return
          }
        } catch {
          /* Forward what is not JSON as it is. */
        }
        socket.send(data)
      })
      server.addEventListener("close", () => void socket.close())
      server.addEventListener("error", () => void socket.close())
      socket.onClose(() => server.close())
    },
  )
  return rpc
}
