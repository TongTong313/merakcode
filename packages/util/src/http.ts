import { serve as listen } from "@hono/node-server"
import type { Server as HttpServer } from "node:http"
import type { AddressInfo, Socket } from "node:net"

/**
 * Small HTTP server for OAuth callbacks, the local control port and fake model servers in tests.
 * Handlers are fetch-style (Request → Response). serve is async because the port is only known once listening.
 */
export namespace Http {
  export type Options = {
    fetch: (request: Request) => Response | Promise<Response>
    /** Defaults to 0, letting the OS pick a port */
    port?: number
    /** Defaults to 127.0.0.1 */
    hostname?: string
    /** Response when the handler throws; 500 when omitted */
    error?: (error: Error) => Response | Promise<Response>
  }

  export type Server = {
    readonly url: URL
    readonly hostname: string
    readonly port: number
    /** With force, drops open connections immediately; otherwise waits for in-flight requests */
    stop(force?: boolean): Promise<void>
    [Symbol.asyncDispose](): Promise<void>
  }

  /**
   * Tracks every connection of the server and returns the set of open ones. Needed for a forced stop: connections
   * upgraded to WebSocket are not covered by closeAllConnections, and unless destroyed, server.close waits forever.
   */
  export function track(http: HttpServer) {
    const sockets = new Set<Socket>()
    http.on("connection", (socket: Socket) => {
      sockets.add(socket)
      socket.once("close", () => sockets.delete(socket))
    })
    return sockets
  }

  /** Stops the server. With force, destroys every socket in sockets; otherwise waits for in-flight requests */
  export async function close(http: HttpServer, sockets: Set<Socket>, force?: boolean) {
    if (!http.listening) return
    const closed = new Promise<void>((done) => http.close(() => done()))
    if (!force) {
      http.closeIdleConnections()
      return closed
    }
    const open = [...sockets].map((socket) => new Promise<void>((done) => socket.once("close", () => done())))
    for (const socket of sockets) socket.destroy()
    await Promise.race([closed, Promise.all(open)])
  }

  export function serve(options: Options) {
    const hostname = options.hostname ?? "127.0.0.1"
    return new Promise<Server>((resolve, reject) => {
      const http = listen({
        hostname,
        port: options.port ?? 0,
        fetch: async (request) => {
          try {
            return await options.fetch(request)
          } catch (error) {
            const failure = error instanceof Error ? error : new Error(String(error))
            if (options.error) return options.error(failure)
            return new Response(failure.message, { status: 500 })
          }
        },
      }) as HttpServer
      const sockets = track(http)
      http.once("error", reject)
      http.once("listening", () => {
        http.off("error", reject)
        const port = (http.address() as AddressInfo).port
        const host = hostname.includes(":") ? `[${hostname}]` : hostname
        const stop = (force?: boolean) => close(http, sockets, force)
        resolve({
          url: new URL(`http://${host}:${port}`),
          hostname,
          port,
          stop,
          [Symbol.asyncDispose]: () => stop(true),
        })
      })
    })
  }
}
