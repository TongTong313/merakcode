import { execFile, spawn } from "node:child_process"
import { mkdtemp, readFile, writeFile, rm, chmod, readdir, mkdir } from "node:fs/promises"
import { createServer } from "node:http"
import { connect as connectSocket, type Socket } from "node:net"
import path from "node:path"
import { tmpdir } from "node:os"
import { promisify } from "node:util"
import { setTimeout as delay } from "node:timers/promises"

/** Real Go engine, authenticated by a local transport proxy just like the desktop host. */
export async function engineFixture(options: { replies?: unknown[] } = {}) {
  const root = await mkdtemp(path.join(tmpdir(), "merak-renderer-"))
  const project = path.join(root, "project")
  await mkdir(project)
  const executable = path.join(root, process.platform === "win32" ? "merak.exe" : "merak")
  await promisify(execFile)("go", ["build", "-o", executable, "./cmd/merak"], {
    cwd: path.resolve(import.meta.dirname, "../../../../../merak"),
    windowsHide: true,
  })
  const script = path.join(root, "replies.json")
  await writeFile(
    script,
    JSON.stringify(options.replies ?? Array.from({ length: 128 }, () => ({ text: "Feedback received" }))),
  )
  const child = spawn(executable, ["serve", "--script", script], {
    cwd: project,
    env: {
      ...Object.fromEntries(Object.entries(process.env).filter(([name]) => !/_API_KEY$/i.test(name))),
      MERAKCODE_HOME: root,
      MERAKCODE_DISABLE_AUTOUPDATE: "1",
      MERAKCODE_DISABLE_CATALOG_FETCH: "1",
      MERAKCODE_DISABLE_LSP_DOWNLOAD: "1",
      MERAKCODE_DISABLE_EXTERNAL_SKILLS: "1",
    },
    stdio: ["ignore", "ignore", "pipe"],
    windowsHide: true,
  })
  let startupError = ""
  child.stderr.on("data", (chunk: Buffer) => {
    startupError = (startupError + chunk.toString()).slice(-8192)
  })
  const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()))
  let info: { endpoint: string; token: string } | undefined
  for (let attempt = 0; attempt < 250; attempt++) {
    if (child.exitCode !== null) throw new Error(`Engine exited: ${child.exitCode}\n${startupError}`)
    info = await readFile(path.join(root, "data", "engine.json"), "utf8").then(
      (body) => JSON.parse(body),
      () => undefined,
    )
    if (info) break
    await delay(20)
  }
  if (!info) throw new Error("Engine did not start")
  const endpoint = new URL(info.endpoint)
  if (endpoint.hostname !== "127.0.0.1") {
    child.kill()
    await exited
    throw new Error("Fixture engine must listen on 127.0.0.1")
  }
  const token = info.token
  const sockets = new Set<Socket>()
  const proxy = createServer((_request, response) => response.end())
  proxy.on("upgrade", (request, socket, head) => {
    const upstream = connectSocket(Number(endpoint.port), endpoint.hostname, () => {
      const headers = {
        ...request.headers,
        host: endpoint.host,
        origin: `http://${endpoint.host}`,
        authorization: `Bearer ${token}`,
      }
      upstream.write(
        `GET /rpc HTTP/1.1\r\n${Object.entries(headers)
          .map(([key, value]) => `${key}: ${value}`)
          .join("\r\n")}\r\n\r\n`,
      )
      if (head.length) upstream.write(head)
      socket.pipe(upstream).pipe(socket)
    })
    sockets.add(upstream)
    upstream.on("close", () => {
      sockets.delete(upstream)
      socket.destroy()
    })
    upstream.on("error", () => socket.destroy())
    socket.on("error", () => upstream.destroy())
    socket.on("close", () => upstream.destroy())
  })
  await new Promise<void>((resolve) => proxy.listen(0, "127.0.0.1", resolve))
  const address = proxy.address()
  if (!address || typeof address === "string") throw new Error("Proxy did not start")
  const git = async (...args: string[]) =>
    (await promisify(execFile)("git", args, { cwd: project, windowsHide: true })).stdout.trim()
  await git("init", "-b", "main")
  await git("config", "core.autocrlf", "false")
  await git("config", "user.name", "Fixture")
  await git("config", "user.email", "fixture@example.invalid")
  return {
    endpoint: info.endpoint,
    token,
    project,
    git,
    url: `http://127.0.0.1:${address.port}`,
    close: async () => {
      for (const socket of sockets) socket.destroy()
      await new Promise<void>((resolve) => proxy.close(() => resolve()))
      child.kill()
      await exited
      for (const name of await readdir(root, { recursive: true }))
        await chmod(path.join(root, name), 0o700).catch(() => {})
      await rm(root, { recursive: true, force: true, maxRetries: 5 })
    },
  }
}
