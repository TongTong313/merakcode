import { z } from "zod"

const controlSchema = z.strictObject({ cursor: z.number().int().nonnegative().safe() })

export type TerminalConnection = {
  send: (text: string) => void
  close: () => void
  readonly cursor: number
  closed: Promise<void>
}

/** Attaches to one terminal, preserving early input ahead of input sent by onOpen. */
export function connectTerminal(options: {
  endpoint: string
  id: string
  token?: string
  cursor?: number
  onData: (data: Uint8Array) => void
  onOpen?: () => void
  onError?: () => void
  onClose?: () => void
}): TerminalConnection {
  const endpoint = new URL(z.url().parse(options.endpoint))
  if (endpoint.protocol === "http:") endpoint.protocol = "ws:"
  if (endpoint.protocol !== "ws:" || endpoint.username || endpoint.password) throw new Error("MRK-3001")
  const id = z.string().min(1).parse(options.id)
  let cursor = z
    .number()
    .int()
    .nonnegative()
    .safe()
    .parse(options.cursor ?? 0)
  endpoint.pathname = `/terminal/${encodeURIComponent(id)}`
  endpoint.search = new URLSearchParams({ cursor: String(cursor) }).toString()
  endpoint.hash = ""
  const NodeWebSocket = WebSocket as typeof WebSocket & {
    new (url: string, options: { headers: Record<string, string> }): WebSocket
  }
  const socket = options.token
    ? new NodeWebSocket(endpoint.href, { headers: { Authorization: `Bearer ${options.token}` } })
    : new WebSocket(endpoint.href)
  socket.binaryType = "arraybuffer"
  const closed = Promise.withResolvers<void>()
  const queued: string[] = []
  let ready = false
  let closing = false
  socket.addEventListener("open", () => {
    if (closing) return
    for (const data of queued.splice(0)) socket.send(data)
    ready = true
    options.onOpen?.()
  })
  socket.addEventListener("message", (message) => {
    if (closing) return
    try {
      if (typeof message.data === "string") cursor = controlSchema.parse(JSON.parse(message.data)).cursor
      else if (message.data instanceof ArrayBuffer) options.onData(new Uint8Array(message.data))
      else throw new Error("MRK-1001")
    } catch {
      options.onError?.()
      socket.close()
    }
  })
  socket.addEventListener("error", () => {
    if (!closing) options.onError?.()
  })
  socket.addEventListener("close", () => {
    ready = false
    closing = true
    queued.length = 0
    closed.resolve()
    options.onClose?.()
  })
  return {
    send(text) {
      if (closing) return
      if (ready) socket.send(text)
      else queued.push(text)
    },
    close() {
      closing = true
      queued.length = 0
      socket.close()
    },
    get cursor() {
      return cursor
    },
    closed: closed.promise,
  }
}
