import { expect, test } from "vitest"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { pathToFileURL } from "url"
import { evaluate, files as Filesystem, runtime, spawn, tmpdir } from "./test-runtime"

test("shutdown cancels a pending init and concurrent init retains only the latest writer", async () => {
  await using root = await tmpdir()
  try {
    const source = pathToFileURL(path.join(import.meta.dirname, "logger.ts")).href
    const child = spawn(
      [
        ...evaluate(
          `
import { Log } from ${JSON.stringify(source)}
const pending = Log.init({ print: false, component: "cancelled", trackRun: false })
await Log.shutdown()
await pending
Log.Product.info("cancelled record")
await Promise.all([
  Log.init({ print: false, component: "superseded", trackRun: false }),
  Log.init({ print: false, component: "latest", trackRun: false }),
])
Log.Product.info("latest record")
await Log.shutdown()
process.exit(0)
`,
        ),
      ],
      {
        env: { ...process.env, MERAKCODE_LOG_ROOT: root.path },
        stdout: "pipe",
        stderr: "pipe",
      },
    )
    const [code, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()])
    expect(code, stderr).toBe(0)
    const dir = path.join(root.path, "production")
    expect(await fs.readdir(dir)).toEqual(["latest"])
    const files = await fs.readdir(path.join(dir, "latest"))
    expect(files).toHaveLength(1)
    expect(JSON.parse((await Filesystem.readText(path.join(dir, "latest", files[0]!))).trim())).toMatchObject({
      message: "latest record",
      component: "latest",
    })
  } finally {
    await fs.rm(root.path, { recursive: true, force: true })
  }
})

test("flush and shutdown drain all channels, reject late records and finish before reinitialization", async () => {
  await using root = await tmpdir()
  try {
    const source = pathToFileURL(path.join(import.meta.dirname, "logger.ts")).href
    const child = spawn(
      [
        ...evaluate(
          `
import { readFile } from "node:fs/promises"
import { Log } from ${JSON.stringify(source)}
await Log.init({ print: false, component: "cli", trackRun: false })
const file = Log.file()
for (let index = 0; index < 500; index++) {
  Log.Product.info("before flush", { index })
  Log.Default.info("sdk before flush", { index })
}
const sdk = Log.sdkFile()
await Log.flush()
const flushed = (await readFile(file, "utf8")).trim().split("\\n").length
const sdkFlushed = (await readFile(sdk, "utf8")).trim().split("\\n").length
const audit = Log.create({ service: "sandbox.audit", channel: "audit" })
for (let index = 0; index < 500; index++) {
  Log.Product.info("before shutdown", { index })
  Log.Default.info("sdk before shutdown", { index })
  audit.info("audit", { index })
  Log.ingest({ component: "web", service: "renderer", level: "INFO", message: "web", sequence: index })
}
const closing = Log.shutdown()
Log.Product.info("late record")
Log.Default.info("late sdk record")
audit.info("late audit")
Log.ingest({ component: "web", service: "renderer", level: "INFO", message: "late web" })
await Log.init({ print: false, component: "backend", trackRun: false })
await closing
Log.Product.info("new run")
const next = Log.file()
await Log.shutdown()
await Log.shutdown()
console.log(JSON.stringify({ file, sdk, next, flushed, sdkFlushed }))
process.exit(0)
`,
        ),
      ],
      {
        env: { ...process.env, MERAKCODE_CLIENT: "", MERAKCODE_LOG_ROOT: root.path },
        stdout: "pipe",
        stderr: "pipe",
      },
    )
    const [code, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ])
    expect(code, stderr).toBe(0)
    const output = JSON.parse(stdout)
    expect(output.flushed).toBe(500)
    expect(output.sdkFlushed).toBe(500)
    const read = async (file: string) =>
      (await Filesystem.readText(file))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line))
    expect(await read(output.file)).toHaveLength(1000)
    const sdk = await read(output.sdk)
    expect(sdk).toHaveLength(1000)
    expect(sdk.some((record) => record.message.startsWith("late"))).toBe(false)
    expect(await read(output.next)).toMatchObject([{ message: "new run" }])
    for (const [directory, prefix] of [
      ["cli/sdk/audit", "audit--"],
      ["server", "browser--"],
    ]) {
      const dir = path.join(root.path, "production", directory!)
      const file = (await fs.readdir(dir)).find((name) => name.startsWith(prefix!))!
      const records = await read(path.join(dir, file))
      expect(records).toHaveLength(500)
      expect(records.some((record) => record.message.startsWith("late"))).toBe(false)
    }
  } finally {
    await fs.rm(root.path, { recursive: true, force: true })
  }
})

test("an unusable log directory cannot prevent startup or change command output", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "merakcode-log-failure-"))
  try {
    const blocked = path.join(root, "not-a-directory")
    await Filesystem.write(blocked, "file")
    const source = pathToFileURL(path.join(import.meta.dirname, "logger.ts")).href
    const child = spawn(
      [
        ...evaluate(
          `import { Log } from ${JSON.stringify(source)}; await Log.init({print:false}); Log.Default.error("failed",{token:"secret"}); await Log.shutdown(); console.log("still-running")`,
        ),
      ],
      {
        env: { ...process.env, MERAKCODE_LOG_ROOT: blocked },
        stdout: "pipe",
        stderr: "pipe",
      },
    )
    const [code, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ])
    expect(code, stderr).toBe(0)
    expect(stdout.trim()).toBe("still-running")
    expect(stderr).toBe("")
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})

test("rotates and retains only the configured number of log files", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "merakcode-log-"))
  const script = path.join(root, "rotate.mts")
  const source = pathToFileURL(path.join(import.meta.dirname, "logger.ts")).href
  await Filesystem.write(
    script,
    `import { Log } from ${JSON.stringify(source)}
await Log.init({ print: false, dev: true, component: "rotation-test", rotate: { size: 512, files: 5 } })
const log = Log.create({ service: "rotation-test", source: "product" })
for (let index = 0; index < 100; index++) log.info("entry", { index, value: "x".repeat(80) })
console.log(Log.file())
await Log.shutdown()
process.exit(0)
`,
  )

  const child = spawn([...runtime, script], {
    env: {
      ...process.env,
      MERAKCODE_HOME: root,
    },
    stdout: "pipe",
    stderr: "pipe",
  })
  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ])
  expect(code, stderr).toBe(0)

  const file = stdout.trim()
  const ext = path.extname(file)
  const base = file.slice(0, -ext.length)
  const files = [file, ...Array.from({ length: 4 }, (_, index) => `${base}.${index + 1}${ext}`)]
  expect(await Promise.all(files.map((item) => Filesystem.isFile(item)))).toEqual([true, true, true, true, true])
  expect(await Filesystem.isFile(`${base}.5${ext}`)).toBe(false)
  expect((await Promise.all(files.map((item) => Filesystem.size(item)))).every((size) => size <= 512)).toBe(true)

  await fs.rm(root, { recursive: true, force: true })
})

test("groups runtime writers by product while preserving separate files", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "merakcode-log-components-"))
  const script = path.join(root, "components.mts")
  const source = pathToFileURL(path.join(import.meta.dirname, "logger.ts")).href
  await Filesystem.write(
    script,
    `import { Log } from ${JSON.stringify(source)}
await Log.init({ print: false, dev: false, component: "backend", trackRun: false })
Log.Product.info("backend-ready")
Log.Default.info("engine-ready")
Log.ingest({ component: "web", service: "renderer", level: "ERROR", message: "window.error", runId: "web-run", sequence: 3 })
await Log.shutdown()
`,
  )

  const child = spawn([...runtime, script], {
    env: { ...process.env, MERAKCODE_CLIENT: "", MERAKCODE_LOG_ROOT: root },
    stdout: "pipe",
    stderr: "pipe",
  })
  const [code, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()])
  expect(code, stderr).toBe(0)

  const read = async (product: string, prefix: string) => {
    const dir = path.join(root, "production", product)
    const files = await fs.readdir(dir)
    const file = files.find((item) => item.startsWith(prefix + "--"))
    expect(file).toBeDefined()
    return JSON.parse((await Filesystem.readText(path.join(dir, file!))).trim())
  }
  const backend = await read("server", "backend")
  const engine = JSON.parse(
    (
      await Filesystem.readText(
        path.join(
          root,
          "production",
          "server",
          "sdk",
          (await fs.readdir(path.join(root, "production", "server", "sdk")))[0]!,
        ),
      )
    ).trim(),
  )
  const web = await read("server", "browser")
  expect(backend).toMatchObject({
    component: "backend",
    message: "backend-ready",
    attributes: { process_role: "backend" },
  })
  expect(engine).toMatchObject({ service: "default", message: "engine-ready" })
  expect(web).toMatchObject({
    component: "web",
    service: "renderer",
    run_id: "web-run",
    sequence: 3,
    attributes: { process_role: "browser" },
  })

  const desktop = spawn([...runtime, script], {
    env: { ...process.env, MERAKCODE_CLIENT: "desktop", MERAKCODE_LOG_ROOT: root },
    stdout: "pipe",
    stderr: "pipe",
  })
  const [desktopCode, desktopStderr] = await Promise.all([desktop.exited, new Response(desktop.stderr).text()])
  expect(desktopCode, desktopStderr).toBe(0)
  expect(await read("desktop", "backend")).toMatchObject({
    component: "backend",
    message: "backend-ready",
    attributes: { process_role: "backend" },
  })

  await fs.rm(root, { recursive: true, force: true })
})

test("routes CLI update, approval and audit events into dedicated structured files", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "merakcode-log-channels-"))
  try {
    const script = path.join(root, "channels.mts")
    const source = pathToFileURL(path.join(import.meta.dirname, "logger.ts")).href
    await Filesystem.write(
      script,
      `import { Log } from ${JSON.stringify(source)}
await Log.init({ print: true, component: "cli", trackRun: false })
Log.create({ service: "updater", channel: "update" }).error("update failed", { updateID: "update-1", exitCode: 17, requestBody: "private" })
Log.create({ service: "sandbox.approval", channel: "approval" }).info("approval choice recorded", { approvalId: "approval-1", choice: "deny", path: "C:\\\\secret\\\\file.txt" })
Log.create({ service: "sandbox.audit", channel: "audit" }).info("file audit recorded", { taskId: "task-1", controlMode: "BLOCK", path: "C:\\\\secret\\\\file.txt", operation: "C:\\\\secret\\\\file.txt", sessionID: "C:\\\\secret\\\\file.txt" })
Log.Default.info("sdk event")
Log.Product.info("ordinary event")
await Log.shutdown()
`,
    )
    const child = spawn([...runtime, script], {
      env: { ...process.env, MERAKCODE_LOG_ROOT: root },
      stdout: "pipe",
      stderr: "pipe",
    })
    const [code, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()])
    expect(code, stderr).toBe(0)

    const read = async (dir: string) => {
      const files = (await fs.readdir(dir, { withFileTypes: true }))
        .filter((item) => item.isFile())
        .map((item) => item.name)
      expect(files).toHaveLength(1)
      return JSON.parse((await Filesystem.readText(path.join(dir, files[0]!))).trim())
    }
    expect(await read(path.join(root, "production", "cli", "update"))).toMatchObject({
      component: "cli",
      service: "updater",
      attributes: { updateID: "update-1", exitCode: 17, requestBody: "<redacted>" },
    })
    expect(await read(path.join(root, "production", "cli"))).toMatchObject({
      message: "ordinary event",
      attributes: { process_role: "main" },
    })
    expect(await read(path.join(root, "production", "cli", "sdk"))).toMatchObject({
      service: "default",
      message: "sdk event",
    })
    const auditDir = path.join(root, "production", "cli", "sdk", "audit")
    const auditFiles = await fs.readdir(auditDir)
    expect(auditFiles).toHaveLength(2)
    const audit = JSON.parse(
      (
        await Filesystem.readText(
          path.join(
            auditDir,
            auditFiles.find((file) => file.startsWith("approval--"))!,
          ),
        )
      ).trim(),
    )
    expect(audit).toMatchObject({
      service: "sandbox.approval",
      message: "approval choice recorded",
      attributes: { approvalId: "approval-1", choice: "deny" },
    })
    expect(audit.attributes).not.toHaveProperty("path")
    const vendorAudit = JSON.parse(
      (
        await Filesystem.readText(
          path.join(
            auditDir,
            auditFiles.find((file) => file.startsWith("audit--"))!,
          ),
        )
      ).trim(),
    )
    expect(vendorAudit).toMatchObject({
      service: "sandbox.audit",
      attributes: { taskId: "task-1", controlMode: "BLOCK" },
    })
    expect(vendorAudit.attributes).not.toHaveProperty("path")
    expect(vendorAudit.attributes).not.toHaveProperty("operation")
    expect(vendorAudit.attributes).not.toHaveProperty("sessionID")
    expect(stderr).toContain("ordinary event")
    expect(stderr).not.toContain("approval choice recorded")
    expect(stderr).not.toContain("file audit recorded")
    expect(stderr).not.toContain("secret")
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})
