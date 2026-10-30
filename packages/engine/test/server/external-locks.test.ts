import { expect, test } from "vitest"
import fs from "node:fs/promises"
import path from "node:path"
import { Runtime } from "@merakcode/util/runtime"
import { Server } from "../../src/app/server/server"
import { tmpdir } from "../fixture/fixture"
import { configureConnections } from "../fixture/agent-connections"
import { fakeModel } from "../../../sdk/js/test/fixture/model"

test.each(["complete", "abort", "disable"] as const)(
  "ends background descendants before another external chat enters the same directory (%s)",
  async (ending) => {
    await using project = await tmpdir()
    const cli = path.join(project.path, "background-cli.cjs")
    const pidFile = path.join(project.path, "background.pid")
    const gate = path.join(project.path, "release-background")
    await fs.writeFile(
      cli,
      [
        `const fs = require("node:fs")`,
        `const path = require("node:path")`,
        `const { spawn, execFileSync } = require("node:child_process")`,
        `let input = ""`,
        `process.stdin.on("data", chunk => input += chunk)`,
        `process.stdin.on("end", async () => {`,
        `  const pidFile = path.join(process.cwd(), "background.pid")`,
        `  if (input === "inspect") {`,
        `    let alive = false`,
        `    try {`,
        `      const pid = Number(fs.readFileSync(pidFile, "utf8"))`,
        `      process.kill(pid, 0)`,
        `      alive = process.platform === "win32" || !execFileSync("ps", ["-p", String(pid), "-o", "stat="], { encoding: "utf8" }).trim().startsWith("Z")`,
        `    } catch {}`,
        `    process.stdout.write(alive ? "overlap" : "serialized")`,
        `    return`,
        `  }`,
        `  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {`,
        `    stdio: "ignore", windowsHide: true, detached: true,`,
        `  })`,
        `  child.unref()`,
        `  fs.writeFileSync(pidFile, String(child.pid))`,
        `  while (!fs.existsSync(input)) await new Promise(resolve => setTimeout(resolve, 10))`,
        `  process.stdout.write("Parent completed")`,
        `})`,
      ].join("\n"),
    )
    await configureConnections({
      background: { command: process.execPath, args: [cli] },
      control: { command: process.execPath, args: [cli] },
    })
    const app = Server.App()
    const request = (url: string, body?: unknown) =>
      app.request(
        `${url}?directory=${encodeURIComponent(project.path)}`,
        body ? { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) } : {},
      )
    const create = async (productID: string) =>
      (await (await request("/session", { target: { kind: "external", productID } })).json()).id as string
    const first = await create("background")
    const second = await create("control")
    const messages = async (id: string) =>
      (await (await request(`/session/${id}/message`)).json()) as {
        info: { terminal?: string }
        parts: { text?: string }[]
      }[]
    try {
      await request(`/session/${first}/prompt_async`, { parts: [{ type: "text", text: gate }] })
      await expect
        .poll(
          () =>
            fs.access(pidFile).then(
              () => true,
              () => false,
            ),
          { timeout: 10_000 },
        )
        .toBe(true)
      await request(`/session/${second}/prompt_async`, { parts: [{ type: "text", text: "inspect" }] })
      await expect.poll(async () => (await messages(second)).length).toBe(2)
      if (ending === "complete") await fs.writeFile(gate, "release")
      if (ending === "abort") expect((await request(`/session/${first}/abort`, {})).status).toBe(200)
      if (ending === "disable")
        expect(
          (await request("/agent-connection/product", { type: "enabled", id: "background", enabled: false })).status,
        ).toBe(200)
      await expect
        .poll(async () => (await messages(second)).at(-1)?.info.terminal, { timeout: 10_000 })
        .toBe("completed")
      expect(
        (await messages(second))
          .at(-1)
          ?.parts.map((part) => part.text ?? "")
          .join(""),
      ).toBe("serialized")
      expect((await messages(first)).at(-1)?.info.terminal).toBe(ending === "complete" ? "completed" : "cancelled")
    } finally {
      await fs.writeFile(gate, "release")
      await request(`/session/${first}/abort`, {})
      await request(`/session/${second}/abort`, {})
      const pid = Number(await fs.readFile(pidFile, "utf8").catch(() => ""))
      if (pid > 0)
        try {
          process.kill(pid)
        } catch {}
    }
  },
)

test("serializes external chats in one directory while another directory proceeds", async () => {
  await configureConnections({
    locks: {
      adapter: "member",
      command: process.execPath,
      args: [...Runtime.execArgv(), path.join(import.meta.dirname, "fixture/lock-adapter.ts")],
    },
  })
  await using project = await tmpdir()
  await using unrelated = await tmpdir()
  const app = Server.App()
  const request = (directory: string, url: string, body?: unknown) =>
    app.request(
      `${url}?directory=${encodeURIComponent(directory)}`,
      body ? { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) } : {},
    )
  const create = async (directory: string) =>
    (await (await request(directory, "/session", { target: { kind: "external", productID: "locks" } })).json())
      .id as string
  const first = await create(project.path)
  const second = await create(project.path)
  const control = await create(unrelated.path)
  const replies = async (id: string) =>
    (await (await request(project.path, `/session/${id}/message`)).json()) as {
      info: { role: string; terminal?: string }
      parts: { text?: string }[]
    }[]
  const gate = path.join(project.path, "release")
  try {
    await request(project.path, `/session/${first}/prompt_async`, { parts: [{ type: "text", text: `hold:${gate}` }] })
    await expect.poll(async () => (await replies(first)).at(-1)?.parts[0]?.text, { timeout: 5000 }).toBe("holding")
    await request(project.path, `/session/${second}/prompt_async`, { parts: [{ type: "text", text: "inspect" }] })
    await expect.poll(async () => (await replies(second)).length).toBe(2)
    const unaffected = await request(unrelated.path, `/session/${control}/message`, {
      parts: [{ type: "text", text: "control" }],
    })
    expect(unaffected.status).toBe(200)
    await unaffected.text()
    await fs.writeFile(gate, "release")
    await expect.poll(async () => (await replies(second)).at(-1)?.info.terminal, { timeout: 5000 }).toBe("completed")
    expect(
      (await replies(second))
        .at(-1)
        ?.parts.map((part) => part.text ?? "")
        .join(""),
    ).toBe("serialized")
  } finally {
    await fs.writeFile(gate, "release")
  }
})

test("cancels a waiting external chat without starting it or leaving a directory lock", async () => {
  await configureConnections({
    locks: {
      adapter: "member",
      command: process.execPath,
      args: [...Runtime.execArgv(), path.join(import.meta.dirname, "fixture/lock-adapter.ts")],
    },
  })
  await using project = await tmpdir()
  const app = Server.App()
  const request = (url: string, body?: unknown) =>
    app.request(
      `${url}?directory=${encodeURIComponent(project.path)}`,
      body ? { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) } : {},
    )
  const create = async () =>
    (await (await request("/session", { target: { kind: "external", productID: "locks" } })).json()).id as string
  const first = await create()
  const second = await create()
  const third = await create()
  const messages = async (id: string) =>
    (await (await request(`/session/${id}/message`)).json()) as {
      info: { terminal?: string }
      parts: { text?: string }[]
    }[]
  const gate = path.join(project.path, "release-cancel")
  try {
    await request(`/session/${first}/prompt_async`, { parts: [{ type: "text", text: `hold:${gate}` }] })
    await expect.poll(async () => (await messages(first)).at(-1)?.parts[0]?.text, { timeout: 5000 }).toBe("holding")
    await request(`/session/${second}/prompt_async`, {
      parts: [{ type: "text", text: `hold:${path.join(project.path, "must-not-start")}` }],
    })
    await expect.poll(async () => (await messages(second)).length).toBe(2)
    expect((await request(`/session/${second}/abort`, {})).status).toBe(200)
    await expect.poll(async () => (await messages(second)).at(-1)?.info.terminal).toBe("cancelled")
    expect((await messages(second)).at(-1)?.parts).toEqual([])
    expect((await messages(first)).at(-1)?.parts[0]?.text).toBe("holding")
    await request(`/session/${third}/prompt_async`, { parts: [{ type: "text", text: "inspect" }] })
    await fs.writeFile(gate, "release")
    await expect.poll(async () => (await messages(third)).at(-1)?.info.terminal, { timeout: 5000 }).toBe("completed")
    expect(
      (await messages(third))
        .at(-1)
        ?.parts.map((part) => part.text ?? "")
        .join(""),
    ).toBe("serialized")
  } finally {
    await fs.writeFile(gate, "release")
  }
})

test("shares external directory holds with a multi-root workspace using the same primary directory", async () => {
  let file = ""
  const model = await fakeModel((turn) =>
    !turn.results.length ? { tool: "write", args: { filePath: file, content: "changed" } } : { text: "Written" },
  )
  try {
    await configureConnections({
      locks: {
        adapter: "member",
        command: process.execPath,
        args: [...Runtime.execArgv(), path.join(import.meta.dirname, "fixture/lock-adapter.ts")],
      },
    })
    await using project = await tmpdir({
      git: true,
      config: {
        model: "alibaba-cn/qwen-plus",
        small_model: "alibaba-cn/qwen-plus",
        enabled_providers: ["alibaba-cn"],
        provider: { "alibaba-cn": { options: { apiKey: "fake", baseURL: model.url } } },
        memory: { auto_extract: false, auto_recall: false, auto_dream: false, session_memory: false },
        lsp: false,
      },
    })
    await using extra = await tmpdir({ git: true })
    file = path.join(project.path, "native-write")
    const app = Server.App()
    const folders = encodeURIComponent(
      JSON.stringify([
        { name: "primary", path: project.path },
        { name: "extra", path: extra.path },
      ]),
    )
    const request = (url: string, body?: unknown, multi = false) =>
      app.request(`${url}?directory=${encodeURIComponent(project.path)}`, {
        ...(body ? { method: "POST", body: JSON.stringify(body) } : {}),
        headers: { "content-type": "application/json", ...(multi ? { "x-merakcode-workspace-folders": folders } : {}) },
      })
    const externalID = (await (await request("/session", { target: { kind: "external", productID: "locks" } })).json())
      .id
    const nativeID = (await (await request("/session", {}, true)).json()).id
    const gate = path.join(project.path, "release-workspace")
    const messages = async (id: string, multi = false) =>
      (await (await request(`/session/${id}/message`, undefined, multi)).json()) as {
        parts: { type: string; tool?: string; text?: string }[]
        info: { terminal?: string }
      }[]
    let native: Promise<Response> | undefined
    try {
      await request(`/session/${externalID}/prompt_async`, { parts: [{ type: "text", text: `hold:${gate}` }] })
      await expect
        .poll(async () => (await messages(externalID)).at(-1)?.parts[0]?.text, { timeout: 5000 })
        .toBe("holding")
      native = Promise.resolve(
        request(
          `/session/${nativeID}/message`,
          { parts: [{ type: "text", text: "write a file" }], permissionMode: "auto" },
          true,
        ),
      )
      await expect
        .poll(
          async () =>
            (await messages(nativeID, true)).some((message) =>
              message.parts.some((part) => part.type === "tool" && part.tool === "write"),
            ),
          { timeout: 5000 },
        )
        .toBe(true)
      await fs.writeFile(gate, "release")
      await expect
        .poll(async () => (await messages(externalID)).at(-1)?.info.terminal, { timeout: 5000 })
        .toBe("completed")
      expect(
        (await messages(externalID))
          .at(-1)
          ?.parts.map((part) => part.text ?? "")
          .join(""),
      ).toBe("released")
    } finally {
      await fs.writeFile(gate, "release")
      if (native) await (await native).text()
    }
  } finally {
    await model.close()
  }
}, 30_000)
