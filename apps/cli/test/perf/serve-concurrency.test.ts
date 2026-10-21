import { expect, test } from "vitest"
import { execFileSync } from "node:child_process"
import { mkdir, readdir, readFile, symlink } from "node:fs/promises"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { setTimeout as delay } from "node:timers/promises"
import { Http } from "@merakcode/util/http"
import { Filesystem } from "@merakcode/util/filesystem"
import { Network } from "@merakcode/util/network"
import { Process } from "@merakcode/util/process"
import { tmpdir } from "../fixture/fixture"
import { product, server, until } from "../fixture/sdk-sequence"

/**
 * One engine process hosts every conversation. This test guards two things:
 * - conversations do not slow each other down: with 10 conversations streaming replies at once, each takes at most
 *   1.2 times as long as a single conversation;
 * - the engine process stays under 500 MB, and the config directory's dependency check runs once, not per conversation.
 * The model is a local fake: requests with tools (the conversation turn) stream slowly, background requests such as
 * titles reply at once.
 */

const CONVERSATIONS = 10
const CHUNKS = 150
// One chunk every 15 ms, about 66 per second, close to a real model's streaming speed

const encoder = new TextEncoder()
const chunk = (delta: object, finish: string | null = null) =>
  `data: ${JSON.stringify({ id: "perf", object: "chat.completion.chunk", choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`

function reply(slow: boolean) {
  const body = new ReadableStream({
    async start(controller) {
      if (!slow) controller.enqueue(encoder.encode(chunk({ role: "assistant", content: "OK" })))
      for (let i = 0; slow && i < CHUNKS; i++) {
        controller.enqueue(
          encoder.encode(chunk(i === 0 ? { role: "assistant", content: "x " } : { content: `t${i} ` })),
        )
        await delay(15)
      }
      controller.enqueue(encoder.encode(chunk({}, "stop") + "data: [DONE]\n\n"))
      controller.close()
    },
  })
  return new Response(body, { headers: { "Content-Type": "text/event-stream" } })
}

/** Resident memory of a process, in bytes */
async function rss(pid: number) {
  if (process.platform === "win32")
    return Number(
      execFileSync("powershell", ["-NoProfile", "-Command", `(Get-Process -Id ${pid}).WorkingSet64`])
        .toString()
        .trim(),
    )
  if (process.platform === "linux")
    return Number(/VmRSS:\s+(\d+)/.exec(await readFile(`/proc/${pid}/status`, "utf8"))![1]) * 1024
  return (
    Number(
      execFileSync("ps", ["-o", "rss=", "-p", String(pid)])
        .toString()
        .trim(),
    ) * 1024
  )
}

async function logLines(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => [])
  const nested = await Promise.all(
    entries.map((entry) =>
      entry.isDirectory()
        ? logLines(join(dir, entry.name))
        : readFile(join(dir, entry.name), "utf8").then((text) => text.split("\n")),
    ),
  )
  return nested.flat()
}

test("10 concurrent conversations in one engine process: no mutual slowdown, bounded memory, one dependency check", async () => {
  await using tmp = await tmpdir()
  const root = tmp.path
  const project = join(root, "project")
  for (const dir of ["project", "home", "node_modules", "cache", "data", "logs", "tmp"])
    await mkdir(join(root, dir), { recursive: true })
  const git = Process.spawn(["git", "init", "--quiet", project], { stdout: "ignore", stderr: "pipe" })
  if (await git.exited) throw new Error("git init failed")
  await Filesystem.write(join(root, "cache/version"), "21")
  // The dependency check must resolve zod, which cannot be installed offline, so link it in (junctions need no admin
  // rights on Windows)
  await symlink(dirname(fileURLToPath(import.meta.resolve("zod"))), join(root, "node_modules/zod"), "junction")

  await using model = await Http.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const body = (await request.json()) as { tools?: unknown[] }
      return reply((body.tools ?? []).length > 0)
    },
  })
  await Filesystem.write(
    join(project, "merakcode.json"),
    JSON.stringify({
      model: "alibaba-cn/qwen-plus",
      small_model: "alibaba-cn/qwen-plus",
      enabled_providers: ["alibaba-cn"],
      provider: { "alibaba-cn": { options: { apiKey: "perf", baseURL: `${model.url.origin}/v1` } } },
      memory: { auto_extract: false, auto_recall: false, session_memory: false, auto_dream: false },
      lsp: false,
    }),
  )

  const env: Record<string, string> = {
    PATH: process.env.PATH!,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_TERMINAL_PROMPT: "0",
    HOME: join(root, "home"),
    USERPROFILE: join(root, "home"),
    TMPDIR: join(root, "tmp"),
    ...Object.fromEntries(
      ["SystemRoot", "SystemDrive", "windir", "ComSpec", "PATHEXT"].flatMap((name) =>
        process.platform === "win32" && process.env[name] ? [[name, process.env[name]]] : [],
      ),
    ),
    MERAKCODE_HOME: root,
    MERAKCODE_TEST_HOME: join(root, "home"),
    MERAKCODE_I1_NETWORK_LOG: join(root, "blocked-network.txt"),
    MERAKCODE_DISABLE_MODELS_FETCH: "1",
    MERAKCODE_SANDBOX_MODE: "off",
    MERAKCODE_DISABLE_LSP_DOWNLOAD: "1",
    MERAKCODE_DISABLE_CLAUDE_CODE: "1",
    MERAKCODE_DISABLE_EXTERNAL_SKILLS: "1",
    MERAKCODE_MODELS_PATH: fileURLToPath(
      new URL("../../../../packages/engine/test/tool/fixtures/models-api.json", import.meta.url),
    ),
    LANG: "en_US.UTF-8",
  }
  const port = await Network.freePort()
  const backend = server(product("serve", "--hostname", "127.0.0.1", "--port", String(port)), { cwd: project, env })
  let output = ""
  const drains = [backend.drain("stdout", (text) => (output += text)), backend.drain("stderr", () => {})]
  try {
    await until(
      () => {
        if (backend.exitCode !== null) throw new Error(`serve exited early: ${backend.exitCode}`)
        return output.includes("listening on")
      },
      "serve listening",
      60_000,
    )
    const url = `http://127.0.0.1:${port}`
    const api = async (route: string, body: unknown) => {
      const response = await fetch(`${url}${route}`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-merakcode-directory": encodeURIComponent(project) },
        body: JSON.stringify(body),
      })
      if (!response.ok) throw new Error(`${route} ${response.status}`)
      return response.json() as Promise<{ id: string; info?: { error?: unknown } }>
    }
    const turn = async (id: string) => {
      const started = performance.now()
      const message = await api(`/session/${id}/message`, { parts: [{ type: "text", text: "继续" }] })
      expect(message.info?.error).toBeUndefined()
      return performance.now() - started
    }

    const sessions = await Promise.all(Array.from({ length: CONVERSATIONS }, () => api("/session", {})))
    // Warm up with one turn each (loads the provider, generates titles), so only the conversation itself is timed
    await Promise.all(sessions.map((session) => turn(session.id)))
    const single = ((await turn(sessions[0]!.id)) + (await turn(sessions[0]!.id))) / 2
    const concurrent = await Promise.all(sessions.map((session) => turn(session.id)))
    const memory = await rss(backend.pid!)

    expect(Math.max(...concurrent) / single).toBeLessThanOrEqual(1.2)
    expect(memory).toBeLessThanOrEqual(500 * 1024 * 1024)
  } finally {
    backend.stop()
    await backend.exited
    await Promise.all(drains)
  }
  // The global config directory is the root itself; the quoted path matches it and not the directories below it
  const installs = (await logLines(join(root, "logs"))).filter(
    (line) => line.includes("dependency.install.") && line.includes(JSON.stringify(root)),
  )
  expect(installs).toHaveLength(1)
}, 180_000)
