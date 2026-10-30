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
}

export type PtyConnection = {
  /** Input is queued until the socket opens, preserving keys typed during terminal startup. */
  send(data: string): void
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
      for (const data of queued.splice(0)) socket.send(data)
    }
  })
  socket.addEventListener("message", (event) => {
    if (!closed) input.onData(event.data as string | ArrayBuffer)
  })
  socket.addEventListener("error", (event) => {
    if (!closed) input.onError?.(event)
  })
  return {
    send(data) {
      if (closed) return
      if (socket.readyState === WebSocket.OPEN) socket.send(data)
      else queued.push(data)
    },
    close() {
      if (closed) return
      closed = true
      queued.length = 0
      socket.close()
    },
  }
}
