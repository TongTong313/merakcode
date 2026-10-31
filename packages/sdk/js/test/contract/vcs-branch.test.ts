import { execFileSync } from "node:child_process"
import { chmod, rm } from "node:fs/promises"
import path from "node:path"
import { afterAll, beforeAll, beforeEach, expect, test } from "vitest"
import { Filesystem } from "@merakcode/util/filesystem"
import { createMerakCode, type MerakCode } from "@merakcode/sdk"
import { engine, sandbox, type Sandbox } from "../fixture/engine"
import { fakeModel, type Reply, type Turn } from "../fixture/model"

let env: Sandbox
let merak: MerakCode
let model: Awaited<ReturnType<typeof fakeModel>>
let reply: (turn: Turn) => Reply | Promise<Reply> = () => ({ text: "OK" })

function git(...args: string[]) {
  return execFileSync("git", ["-c", "user.name=Branch Test", "-c", "user.email=branch@example.test", ...args], {
    cwd: env.project,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim()
}

beforeAll(async () => {
  model = await fakeModel((turn) => reply(turn))
  env = await sandbox(model.url)
  git("config", "core.autocrlf", "false")
  await Filesystem.write(path.join(env.project, "branch.txt"), "main content\n")
  git("add", "branch.txt")
  git("commit", "--quiet", "-m", "initial")
  git("branch", "-M", "main")
  git("switch", "--quiet", "-c", "dev")
  await Filesystem.write(path.join(env.project, "branch.txt"), "dev content\n")
  git("commit", "--quiet", "-am", "dev")
  git("switch", "--quiet", "main")
  merak = await createMerakCode({ cwd: env.project, executablePath: engine, env: env.env })
}, 120_000)

beforeEach(() => {
  git("switch", "--quiet", "main")
})

test("refuses to switch with untracked changes and preserves their contents", async () => {
  const { client } = merak
  await client.file.write({ path: "draft.txt", content: "keep this draft\n" }, { throwOnError: true })
  try {
    const before = (await client.vcs.branchOptions({}, { throwOnError: true })).data.current!
    const result = await client.vcs.switchBranch({
      branch: before.branch === "main" ? "dev" : "main",
      expectedCheckout: before.checkout,
    })
    expect(result.response.status).toBe(409)
    expect((await client.vcs.get({}, { throwOnError: true })).data.branch).toBe(before.branch)
    expect((await client.file.read({ path: "draft.txt" }, { throwOnError: true })).data).toMatchObject({
      content: "keep this draft\n",
    })
  } finally {
    await client.file.delete({ path: "draft.txt" }, { throwOnError: true })
  }
}, 120_000)

test("refuses to switch while the checkout's session is running", async () => {
  const { client } = merak
  let entered = false
  let release!: () => void
  const blocked = new Promise<void>((resolve) => (release = resolve))
  reply = async () => {
    entered = true
    await blocked
    return { text: "finished" }
  }
  const session = await merak.session()
  const running = (async () => {
    for await (const event of session.run("Wait for this request", { mode: "auto" })) void event
  })()
  try {
    await expect.poll(() => entered, { timeout: 30_000 }).toBe(true)
    const before = (await client.vcs.branchOptions({}, { throwOnError: true })).data.current!
    const result = await client.vcs.switchBranch({ branch: "dev", expectedCheckout: before.checkout })
    expect(result.response.status).toBe(409)
    expect((await client.vcs.get({}, { throwOnError: true })).data.branch).toBe("main")
  } finally {
    release()
    reply = () => ({ text: "OK" })
    await running
  }
}, 120_000)

test("refuses to switch while a direct session shell is running", async () => {
  const { client } = merak
  const session = await merak.session()
  const running = client.session.shell({
    sessionID: session.id,
    agent: "build",
    permissionMode: "auto",
    command: 'node -e "setTimeout(() => {}, 30000)"',
  })
  try {
    await expect
      .poll(
        async () =>
          (await client.session.messages({ sessionID: session.id }, { throwOnError: true })).data
            .flatMap((message) => message.parts)
            .some((part) => part.type === "tool" && part.state.status === "running"),
        { timeout: 30_000 },
      )
      .toBe(true)
    const before = (await client.vcs.branchOptions({}, { throwOnError: true })).data.current!
    const switched = await client.vcs.switchBranch({ branch: "dev", expectedCheckout: before.checkout })
    expect(switched.response.status).toBe(409)
    expect((await client.vcs.get({}, { throwOnError: true })).data.branch).toBe("main")
  } finally {
    await client.session.abort({ sessionID: session.id })
    await running
  }
}, 120_000)

test("keeps a background command protected after its foreground turn finishes", async () => {
  const { client } = merak
  reply = (turn) =>
    turn.results.length
      ? { text: "background started" }
      : {
          tool: "bash_background",
          args: {
            command: 'node -e "setTimeout(() => {}, 30000)"',
            description: "Keep a local process running",
          },
        }
  const session = await merak.session()
  let jobID: string | undefined
  try {
    for await (const event of session.run("Start the background command and finish this turn", { mode: "auto" }))
      void event
    const parts = (await client.session.messages({ sessionID: session.id }, { throwOnError: true })).data.flatMap(
      (message) => message.parts,
    )
    const tool = parts.find((part) => part.type === "tool" && part.tool === "bash_background")
    if (tool?.type === "tool" && tool.state.status === "completed") jobID = String(tool.state.metadata?.jobId)
    expect(jobID).toMatch(/^job_/)
    const before = (await client.vcs.branchOptions({}, { throwOnError: true })).data.current!
    const result = await client.vcs.switchBranch({ branch: "dev", expectedCheckout: before.checkout })
    expect(result.response.status).toBe(409)
    expect((await client.vcs.get({}, { throwOnError: true })).data.branch).toBe("main")
  } finally {
    reply = () => ({ text: "OK" })
    if (jobID) await client.bash.jobStop({ id: jobID })
    await client.session.abort({ sessionID: session.id })
  }
}, 120_000)

test("protects a background workflow even after its cancellation has been acknowledged", async () => {
  const workflowEnv = await sandbox(model.url)
  const workflowGit = (...args: string[]) =>
    execFileSync("git", ["-c", "user.name=Branch Test", "-c", "user.email=branch@example.test", ...args], {
      cwd: workflowEnv.project,
      stdio: "ignore",
    })
  await Filesystem.write(path.join(workflowEnv.project, "file.txt"), "initial\n")
  workflowGit("add", ".")
  workflowGit("commit", "--quiet", "-m", "initial")
  workflowGit("branch", "-M", "main")
  workflowGit("branch", "dev")
  await Filesystem.write(path.join(workflowEnv.project, ".git", "info", "exclude"), ".merakcode/\n")
  const workflowMerak = await createMerakCode({
    cwd: workflowEnv.project,
    executablePath: engine,
    env: workflowEnv.env,
  })
  reply = (turn) =>
    turn.results.length
      ? { text: "workflow started" }
      : {
          tool: "workflow_run",
          args: {
            script:
              'export const meta = { name: "waiting", description: "Wait until the engine stops" }; await new Promise(() => {})',
          },
        }
  try {
    const session = await workflowMerak.session()
    for await (const event of session.run("Start the waiting workflow and finish this turn", { mode: "auto" }))
      void event
    const { client } = workflowMerak
    const workflowParts = (
      await client.session.messages({ sessionID: session.id }, { throwOnError: true })
    ).data.flatMap((message) => message.parts)
    const workflowTool = workflowParts.find(
      (part) => part.type === "tool" && (part.tool === "workflow" || part.tool === "workflow_run"),
    )
    expect(
      workflowTool?.type === "tool" ? workflowTool.state.status : undefined,
      workflowTool?.type === "tool" && workflowTool.state.status === "error" ? workflowTool.state.error : undefined,
    ).toBe("completed")
    const runs = (await client.workflow.list({ sessionID: session.id }, { throwOnError: true })).data
    expect(runs).toHaveLength(1)
    expect(runs[0]!.status).toBe("running")
    await client.workflow.cancel({ sessionID: session.id, runId: runs[0]!.runId }, { throwOnError: true })
    const before = (await client.vcs.branchOptions({}, { throwOnError: true })).data.current!
    const result = await client.vcs.switchBranch({ branch: "dev", expectedCheckout: before.checkout })
    expect(result.response.status).toBe(409)
    expect((await client.vcs.get({}, { throwOnError: true })).data.branch).toBe("main")
  } finally {
    reply = () => ({ text: "OK" })
    await workflowMerak.close()
    await workflowEnv[Symbol.asyncDispose]()
  }
}, 120_000)

test("rejects direct file changes until an in-progress checkout finishes", async () => {
  const { client } = merak
  const marker = path.join(env.root, "checkout-entered")
  const release = path.join(env.root, "checkout-release")
  const helper = path.join(env.root, "checkout-hook.cjs")
  const hook = path.join(env.project, ".git", "hooks", "post-checkout")
  await Filesystem.write(
    helper,
    'const fs = require("node:fs"); fs.writeFileSync(process.argv[2], "ready"); const end = Date.now() + 15000; while (!fs.existsSync(process.argv[3]) && Date.now() < end) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);',
  )
  const forward = (value: string) => value.replaceAll("\\", "/")
  await Filesystem.write(hook, `#!/bin/sh\nnode "${forward(helper)}" "${forward(marker)}" "${forward(release)}"\n`)
  await chmod(hook, 0o755)
  const session = await merak.session()
  const before = (await client.vcs.branchOptions({}, { throwOnError: true })).data.current!
  const switching = client.vcs.switchBranch({ branch: "dev", expectedCheckout: before.checkout })
  try {
    await expect.poll(() => Filesystem.readText(marker).catch(() => ""), { timeout: 10_000 }).toBe("ready")
    const write = await client.file.write({ path: "branch.txt", content: "do not write this\n" })
    expect(write.response.status).toBe(409)
    const deleted = await client.file.delete({ path: "branch.txt" })
    expect(deleted.response.status).toBe(409)
    const prompted = await client.session.prompt({
      sessionID: session.id,
      parts: [{ type: "text", text: "Wait until the checkout finishes" }],
    })
    expect(prompted.response.status).toBe(409)
  } finally {
    await Filesystem.write(release, "release")
    await switching
    await rm(hook, { force: true })
    await client.file.write({ path: "branch.txt", content: "dev content\n" }, { throwOnError: true })
  }
}, 120_000)

test("keeps cancelled command preparation protected until the actual command settles", async () => {
  const preparing = await sandbox(model.url, { command: { late: { template: "!`node prepare.cjs`" } } })
  const marker = path.join(preparing.root, "prepare-entered")
  const release = path.join(preparing.root, "prepare-release")
  await Filesystem.write(
    path.join(preparing.project, "prepare.cjs"),
    'const fs = require("node:fs"), path = require("node:path"); const root = process.env.MERAKCODE_HOME; fs.writeFileSync(path.join(root, "prepare-entered"), "ready"); const end = Date.now() + 15000; while (!fs.existsSync(path.join(root, "prepare-release")) && Date.now() < end) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25); fs.writeFileSync("late.txt", "late content");',
  )
  const preparingGit = (...args: string[]) =>
    execFileSync("git", ["-c", "user.name=Branch Test", "-c", "user.email=branch@example.test", ...args], {
      cwd: preparing.project,
      stdio: "ignore",
    })
  preparingGit("add", ".")
  preparingGit("commit", "--quiet", "-m", "initial")
  preparingGit("branch", "-M", "main")
  preparingGit("branch", "dev")
  const preparingMerak = await createMerakCode({ cwd: preparing.project, executablePath: engine, env: preparing.env })
  const session = await preparingMerak.session()
  const { client } = preparingMerak
  const pending = client.session.command({
    sessionID: session.id,
    command: "late",
    arguments: "",
    permissionMode: "auto",
  })
  try {
    await expect.poll(() => Filesystem.readText(marker).catch(() => ""), { timeout: 10_000 }).toBe("ready")
    await client.session.abort({ sessionID: session.id }, { throwOnError: true })
    const before = (await client.vcs.branchOptions({}, { throwOnError: true })).data.current!
    const switched = await client.vcs.switchBranch({ branch: "dev", expectedCheckout: before.checkout })
    expect(switched.response.status).toBe(409)
  } finally {
    await Filesystem.write(release, "release")
    await pending
    await expect
      .poll(async () => (await client.file.read({ path: "late.txt" }, { throwOnError: true })).data.content)
      .toBe("late content")
    await preparingMerak.close()
    await preparing[Symbol.asyncDispose]()
  }
}, 120_000)

test("keeps inherited background pipes protected after their parent exits and cancellation is acknowledged", async () => {
  const { client } = merak
  const marker = path.join(env.root, "descendant-entered")
  const release = path.join(env.root, "descendant-release")
  const child = path.join(env.root, "descendant.cjs")
  const spawner = path.join(env.root, "spawner.cjs")
  await Filesystem.write(
    child,
    'const fs = require("node:fs"); process.on("disconnect", () => fs.writeFileSync(process.argv[2], "ready")); process.send("ready"); const end = Date.now() + 60000; const timer = setInterval(() => { if (!fs.existsSync(process.argv[3]) && Date.now() < end) return; clearInterval(timer); fs.writeFileSync(process.argv[4], "finished"); }, 25);',
  )
  await Filesystem.write(
    spawner,
    `const child = require("node:child_process").spawn(process.execPath, ${JSON.stringify([child, marker, release, path.join(env.project, "descendant.txt")])}, { detached: true, windowsHide: true, stdio: ["inherit", "inherit", "inherit", "ipc"] }); child.on("message", () => process.exit(0));`,
  )
  reply = (turn) =>
    turn.results.length || !turn.prompt.includes("inherited background")
      ? { text: "started" }
      : {
          tool: "bash_background",
          args: {
            command: `node "${spawner.replaceAll("\\", "/")}"`,
            description: "Start a process with inherited output",
          },
        }
  const session = await merak.session()
  let entered = false
  try {
    for await (const event of session.run("Start the inherited background bash_background command and finish", {
      mode: "auto",
    }))
      void event
    const parts = (await client.session.messages({ sessionID: session.id }, { throwOnError: true })).data.flatMap(
      (message) => message.parts,
    )
    const background = parts.find((part) => part.type === "tool" && part.tool === "bash_background")
    expect(
      background?.type === "tool" ? background.state.status : undefined,
      background?.type === "tool" && background.state.status === "error" ? background.state.error : undefined,
    ).toBe("completed")
    await expect.poll(() => Filesystem.readText(marker).catch(() => ""), { timeout: 10_000 }).toBe("ready")
    entered = true
    const before = (await client.vcs.branchOptions({}, { throwOnError: true })).data.current!
    const switched = await client.vcs.switchBranch({ branch: "dev", expectedCheckout: before.checkout })
    expect(switched.response.status).toBe(409)
    const jobId =
      background?.type === "tool" && background.state.status === "completed" && background.state.metadata.jobId
    expect(typeof jobId).toBe("string")
    expect((await client.bash.jobStop({ id: String(jobId) }, { throwOnError: true })).data).toBe(true)
    await client.session.abort({ sessionID: session.id }, { throwOnError: true })
    const afterCancel = (await client.vcs.branchOptions({}, { throwOnError: true })).data.current!
    const cancelled = await client.vcs.switchBranch({ branch: "dev", expectedCheckout: afterCancel.checkout })
    expect(cancelled.response.status).toBe(409)
  } finally {
    reply = () => ({ text: "OK" })
    await Filesystem.write(release, "release")
    if (entered)
      await expect
        .poll(async () => (await client.file.read({ path: "descendant.txt" }, { throwOnError: true })).data.content, {
          timeout: 10_000,
        })
        .toBe("finished")
    await client.session.abort({ sessionID: session.id })
    await client.file.delete({ path: "descendant.txt" })
  }
  await expect
    .poll(async () => (await client.vcs.branchOptions({}, { throwOnError: true })).data.blocked?.reason, {
      timeout: 10_000,
    })
    .not.toBe("busy")
  const settled = (await client.vcs.branchOptions({}, { throwOnError: true })).data.current!
  expect((await client.vcs.switchBranch({ branch: "dev", expectedCheckout: settled.checkout })).response.status).toBe(
    200,
  )
}, 120_000)

test("stopping a background job ends its live parent and child and releases the checkout", async () => {
  const { client } = merak
  const marker = path.join(env.root, "background-pids.json")
  const spawner = path.join(env.root, "attached-spawner.cjs")
  await Filesystem.write(
    spawner,
    `
const fs = require("node:fs")
const child = require("node:child_process").spawn(process.execPath, ["-e", 'process.send("ready"); setInterval(() => {}, 1000)'], {
  windowsHide: true, stdio: ["inherit", "inherit", "inherit", "ipc"]
})
child.on("message", () => fs.writeFileSync(${JSON.stringify(marker)}, JSON.stringify([process.pid, child.pid])))
setInterval(() => {}, 1000)
`,
  )
  reply = (turn) =>
    turn.results.length || !turn.prompt.includes("Start the attached background processes")
      ? { text: "started" }
      : {
          tool: "bash_background",
          args: { command: `node "${spawner.replaceAll("\\", "/")}"`, description: "Start a parent and child" },
        }
  const session = await merak.session()
  let jobID: string | undefined
  try {
    for await (const event of session.run("Start the attached background processes", { mode: "auto" })) void event
    await expect.poll(() => Filesystem.readText(marker).catch(() => ""), { timeout: 10_000 }).not.toBe("")
    const pids = JSON.parse(await Filesystem.readText(marker)) as number[]
    expect(pids).toHaveLength(2)
    const parts = (await client.session.messages({ sessionID: session.id }, { throwOnError: true })).data.flatMap(
      (message) => message.parts,
    )
    const part = parts.find((part) => part.type === "tool" && part.tool === "bash_background")
    const id = part?.type === "tool" && part.state.status === "completed" && part.state.metadata.jobId
    expect(typeof id).toBe("string")
    jobID = String(id)
    expect((await client.bash.jobStop({ id: jobID }, { throwOnError: true })).data).toBe(true)
    await client.session.abort({ sessionID: session.id }, { throwOnError: true })
    await expect
      .poll(
        () =>
          pids.every((pid) => {
            try {
              process.kill(pid, 0)
              return false
            } catch (error) {
              if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error
              return true
            }
          }),
        { timeout: 10_000 },
      )
      .toBe(true)
    await expect
      .poll(async () => (await client.vcs.branchOptions({}, { throwOnError: true })).data.blocked?.reason, {
        timeout: 10_000,
      })
      .not.toBe("busy")
    const before = (await client.vcs.branchOptions({}, { throwOnError: true })).data.current!
    expect((await client.vcs.switchBranch({ branch: "dev", expectedCheckout: before.checkout })).response.status).toBe(
      200,
    )
  } finally {
    reply = () => ({ text: "OK" })
    if (jobID) await client.bash.jobStop({ id: jobID })
    await client.session.abort({ sessionID: session.id })
  }
}, 120_000)

test("reports a background process start failure once and releases its checkout", async () => {
  const failing = await sandbox(model.url)
  const failingGit = (...args: string[]) =>
    execFileSync("git", ["-c", "user.name=Branch Test", "-c", "user.email=branch@example.test", ...args], {
      cwd: failing.project,
      stdio: "ignore",
    })
  failingGit("commit", "--quiet", "--allow-empty", "-m", "initial")
  failingGit("branch", "-M", "main")
  failingGit("branch", "dev")
  const failingMerak = await createMerakCode({
    cwd: failing.project,
    executablePath: engine,
    env: { ...failing.env, SHELL: path.join(failing.root, "missing-shell") },
  })
  let notifications = 0
  reply = (turn) => {
    if (turn.prompt.startsWith("[Background bash job")) {
      notifications++
      return { text: "received" }
    }
    if (turn.results.length || !turn.prompt.includes("failing background")) return { text: "started" }
    return { tool: "bash_background", args: { command: "echo started", description: "Start a failing process" } }
  }
  const session = await failingMerak.session()
  try {
    for await (const event of session.run("Start a failing background bash_background command", { mode: "auto" }))
      void event
    await expect.poll(() => notifications, { timeout: 10_000 }).toBeGreaterThan(0)
    for await (const event of session.run("Continue after the process failure", { mode: "auto" })) void event
    const messages = (await failingMerak.client.session.messages({ sessionID: session.id }, { throwOnError: true }))
      .data
    const background = messages
      .flatMap((message) => message.parts)
      .find((part) => part.type === "tool" && part.tool === "bash_background")
    expect(
      background?.type === "tool" && background.state.status === "completed" && background.state.metadata.status,
    ).toBe("failed")
    expect(notifications).toBe(1)
    const options = (await failingMerak.client.vcs.branchOptions({}, { throwOnError: true })).data
    const result = await failingMerak.client.vcs.switchBranch({
      branch: "dev",
      expectedCheckout: options.current!.checkout,
    })
    expect(result.response.status).toBe(200)
  } finally {
    reply = () => ({ text: "OK" })
    await failingMerak.close()
    await failing[Symbol.asyncDispose]()
  }
}, 120_000)

test("reports a Git switch failure with the declared error and refreshes the actual branch", async () => {
  const hook = path.join(env.project, ".git", "hooks", "post-checkout")
  await Filesystem.write(hook, "#!/bin/sh\nexit 7\n")
  await chmod(hook, 0o755)
  try {
    const before = (await merak.client.vcs.branchOptions({}, { throwOnError: true })).data.current!
    const result = await merak.client.vcs.switchBranch({ branch: "dev", expectedCheckout: before.checkout })
    expect(result.response.status).toBe(400)
    expect(result.error).toMatchObject({ name: "VcsSwitchFailedError", code: "MRK-7008" })
    expect((await merak.client.vcs.branchOptions({}, { throwOnError: true })).data.current?.branch).toBe("dev")
  } finally {
    await rm(hook, { force: true })
  }
}, 120_000)

afterAll(async () => {
  await merak?.close()
  await model?.close()
  await env?.[Symbol.asyncDispose]()
})

test("switches a clean checkout and exposes its branch, contents and head event", async () => {
  const { client } = merak
  const listed = (await client.vcs.branchOptions({}, { throwOnError: true })).data
  expect(listed.current?.branch).toBe("main")
  const abort = new AbortController()
  const events = await client.event.subscribe(undefined, { signal: abort.signal })
  const updated = (async () => {
    for await (const event of events.stream)
      if (event.type === "vcs.head.updated" && event.properties.branch === "dev") return event.properties
  })()
  try {
    const switched = (
      await client.vcs.switchBranch(
        { branch: "dev", expectedCheckout: listed.current!.checkout },
        { throwOnError: true },
      )
    ).data
    expect(switched).toMatchObject({ branch: "dev", changed: true })
    expect((await client.vcs.get({}, { throwOnError: true })).data).toMatchObject({
      branch: "dev",
      checkout: switched.checkout,
    })
    expect((await client.file.read({ path: "branch.txt" }, { throwOnError: true })).data).toMatchObject({
      content: "dev content\n",
    })
    expect(await updated).toMatchObject({ branch: "dev", branchChanged: true, checkout: switched.checkout })
  } finally {
    abort.abort()
  }
}, 120_000)
