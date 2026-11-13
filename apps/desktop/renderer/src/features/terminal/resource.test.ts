import { mkdir } from "node:fs/promises"
import { createServer, type Server } from "node:http"
import { connect as connectSocket, type Socket } from "node:net"
import path from "node:path"
import { connectTerminal } from "@merakcode/sdk"
import { afterAll, beforeAll, expect, test } from "vitest"
import { engineFixture } from "../../test/engine"
import { client } from "../../state/client"
import { codeOf } from "../../state/error"
import { createPanels } from "../panel/state"
import { sendTerminalInput, stopAllTerminals, stopTerminal, terminalFor } from "./resource"

let env: Awaited<ReturnType<typeof engineFixture>>
let proxy: Server
const upstream = new Set<Socket>()

/** The shared fixture proxy only forwards the RPC socket; the input stream needs the terminal path as well. */
async function terminalProxy() {
  const endpoint = new URL(env.endpoint)
  const server = createServer((_request, response) => response.end())
  server.on("upgrade", (request, socket, head) => {
    const target = connectSocket(Number(endpoint.port), endpoint.hostname, () => {
      const headers = {
        ...request.headers,
        host: endpoint.host,
        origin: `http://${endpoint.host}`,
        authorization: `Bearer ${env.token}`,
      }
      target.write(
        `GET ${request.url} HTTP/1.1\r\n${Object.entries(headers)
          .map(([key, value]) => `${key}: ${value}`)
          .join("\r\n")}\r\n\r\n`,
      )
      if (head.length) target.write(head)
      socket.pipe(target).pipe(socket)
    })
    upstream.add(target)
    target.on("close", () => {
      upstream.delete(target)
      socket.destroy()
    })
    target.on("error", () => socket.destroy())
    socket.on("error", () => target.destroy())
    socket.on("close", () => target.destroy())
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  return { server, url: `http://127.0.0.1:${(server.address() as { port: number }).port}` }
}

beforeAll(async () => {
  env = await engineFixture()
  const started = await terminalProxy()
  proxy = started.server
  location.href = started.url
}, 120_000)
afterAll(async () => {
  await stopAllTerminals().catch(() => {})
  try {
    await (await client()).close()
  } finally {
    for (const socket of upstream) socket.destroy()
    await new Promise<void>((resolve) => proxy?.close(() => resolve()))
    await env?.close()
  }
})

const memory = () => ({ get: async () => null, set: async () => {} })

/** Everything a terminal printed, read through a fresh attachment that replays from the start. */
async function transcript(id: string, until: string) {
  let output = ""
  const decoder = new TextDecoder()
  const reader = connectTerminal({
    endpoint: location.origin,
    id,
    cursor: 0,
    onData: (body) => {
      output += decoder.decode(body, { stream: true })
    },
  })
  try {
    await expect.poll(() => output, { timeout: 20_000 }).toContain(until)
    return output
  } finally {
    reader.close()
    await reader.closed
  }
}

test("a terminal created for a tab is stored in the tab, a remount reuses it, and stopping removes it", async () => {
  const owner = await createPanels("terminal-reuse", memory())
  const id = owner.open({ kind: "terminal", ptyDirectory: env.project })
  const connection = await client()
  const address = await terminalFor(owner.state.tabs[0]!, env.project, owner)
  expect(address).toMatchObject({ directory: env.project })
  expect(owner.state.tabs[0]).toMatchObject({ id, ptyID: address!.ptyID, ptyDirectory: env.project })
  expect(await terminalFor(owner.state.tabs[0]!, env.project, owner)).toEqual(address)
  expect((await connection.terminal.list({ directory: env.project }))?.map((info) => info.id)).toEqual([address!.ptyID])
  await stopTerminal(owner.state.tabs[0]!)
  const removed = await connection.terminal.get({ id: address!.ptyID }).catch((error: unknown) => error)
  expect(removed).toBeInstanceOf(Error)
  expect((await connection.terminal.list({ directory: env.project })) ?? []).toEqual([])
})

test("a failed creation preserves the tab for a retry and never leaves a terminal behind", async () => {
  const directory = path.join(env.project, "later")
  const owner = await createPanels("terminal-retry", memory())
  owner.open({ kind: "terminal", ptyDirectory: directory })
  const tab = owner.state.tabs[0]!
  const connection = await client()
  await expect(terminalFor(tab, directory, owner)).rejects.toThrow()
  await new Promise((resolve) => setTimeout(resolve, 20))
  expect(owner.state.tabs[0]!.ptyID).toBeUndefined()
  expect((await connection.terminal.list({ directory: env.project })) ?? []).toEqual([])
  await mkdir(directory)
  const address = await terminalFor(owner.state.tabs[0]!, directory, owner)
  expect(address).toMatchObject({ directory })
  expect(owner.state.tabs[0]!.ptyID).toBe(address!.ptyID)
  await stopTerminal(owner.state.tabs[0]!)
})

test("a terminal removed behind the app's back ends its tab instead of being created again", async () => {
  const owner = await createPanels("terminal-gone", memory())
  owner.open({ kind: "terminal", ptyDirectory: env.project })
  const connection = await client()
  const address = await terminalFor(owner.state.tabs[0]!, env.project, owner)
  await connection.terminal.remove({ id: address!.ptyID })
  // The tab still names the removed terminal, as it does after a restart.
  const restored = await createPanels("terminal-gone-restored", memory())
  restored.open({ kind: "terminal", ptyID: address!.ptyID, ptyDirectory: env.project })
  expect(codeOf(await connection.terminal.get({ id: address!.ptyID }).catch((error: unknown) => error))).toBe(
    "MRK-5001",
  )
  expect(await terminalFor(restored.state.tabs[0]!, env.project, restored)).toBeUndefined()
  await expect.poll(() => restored.view(restored.state.tabs[0]!.id).ended, { timeout: 15_000 }).toBe(true)
  expect(await terminalFor(restored.state.tabs[0]!, env.project, restored)).toBeUndefined()
  expect((await connection.terminal.list({ directory: env.project })) ?? []).toEqual([])
})

test("input sent before the terminal exists and after its stream drops reaches the shell in order", async () => {
  const owner = await createPanels("terminal-input", memory())
  const id = owner.open({ kind: "terminal", ptyDirectory: env.project })
  const tab = owner.state.tabs[0]!
  const creating = terminalFor(tab, env.project, owner)
  await sendTerminalInput(id, "echo FIRST-KEY\r\n")
  const address = (await creating)!
  await transcript(address.ptyID, "FIRST-KEY")
  for (const socket of upstream) socket.destroy()
  await new Promise((resolve) => setTimeout(resolve, 100))
  await sendTerminalInput(id, "echo SECOND-KEY\r\n")
  await sendTerminalInput(id, "echo THIRD-KEY\r\n")
  const output = await transcript(address.ptyID, "THIRD-KEY")
  expect(output.indexOf("FIRST-KEY")).toBeLessThan(output.indexOf("SECOND-KEY"))
  expect(output.lastIndexOf("SECOND-KEY")).toBeLessThan(output.lastIndexOf("THIRD-KEY"))
  await stopTerminal(owner.state.tabs[0]!)
})
