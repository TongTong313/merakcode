export type PtyConnectionOptions = {
  /** Use the same origin as the SDK HTTP client so the host's authentication applies to the upgrade. */
  baseUrl: string | URL
  ptyID: string
  directory?: string
  /** Output cursor to replay from; zero replays the available terminal buffer. */
  cursor?: number
  onData(data: string | ArrayBuffer): void
  onOpen?(): void
  onError?(event: Event): void
  /** A closed transport does not imply that the PTY process has exited. */
  onClose?(event: CloseEvent): void
}

export type PtyConnection = {
  /** Returns false once closing or closed; true means accepted locally, not acknowledged by the PTY. */
  send(data: string): boolean
  close(): void
}

/** Connects to an existing PTY through the engine's WebSocket route. */
export function connectPty(input: PtyConnectionOptions): PtyConnection {
  const url = new URL(`/pty/${encodeURIComponent(input.ptyID)}/connect`, input.baseUrl)
  if (input.directory) url.searchParams.set("directory", input.directory)
  url.searchParams.set("cursor", String(input.cursor ?? 0))
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:"

  const socket = new WebSocket(url)
  socket.binaryType = "arraybuffer"
  const queued: string[] = []
  let closed = false
  socket.addEventListener("open", () => {
    if (closed) return
    try {
      input.onOpen?.()
    } finally {
      if (!closed && socket.readyState === WebSocket.OPEN) for (const data of queued.splice(0)) socket.send(data)
    }
  })
  socket.addEventListener("message", (event) => {
    if (!closed) input.onData(event.data as string | ArrayBuffer)
  })
  socket.addEventListener("error", (event) => {
    if (!closed) input.onError?.(event)
  })
  socket.addEventListener("close", (event) => {
    closed = true
    queued.length = 0
    input.onClose?.(event)
  })
  return {
    send(data) {
      if (closed || socket.readyState === WebSocket.CLOSING || socket.readyState === WebSocket.CLOSED) return false
      // onOpen can send before the existing input queue has drained.
      if (socket.readyState === WebSocket.OPEN && queued.length === 0) socket.send(data)
      else queued.push(data)
      return true
    },
    close() {
      if (closed) return
      closed = true
      queued.length = 0
      socket.close()
    },
  }
}
