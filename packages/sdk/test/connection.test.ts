import { spawn, execFile } from "node:child_process"
import { mkdtemp, readFile, writeFile, rm, mkdir } from "node:fs/promises"
import { randomBytes } from "node:crypto"
import { tmpdir } from "node:os"
import path from "node:path"
import { promisify } from "node:util"
import { setTimeout as delay } from "node:timers/promises"
import { expect, it } from "vitest"
import { connect, watchConversation, type Conversation, type EngineEvent } from "../src/index"

it("connects to a real merak serve and receives a completed conversation", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "merakcode-sdk-"))
  const binary =
    process.env.MERAKCODE_TEST_BINARY ?? path.join(home, process.platform === "win32" ? "merak.exe" : "merak")
  if (!process.env.MERAKCODE_TEST_BINARY)
    await promisify(execFile)("go", ["build", "-o", binary, "./cmd/merak"], {
      cwd: path.resolve(import.meta.dirname, "../../../merak"),
    })
  const script = path.join(home, "replies.json")
  await writeFile(
    script,
    JSON.stringify([
      { text: "Hello from the SDK test." },
      { text: "Group task received." },
      { text: "Message received." },
      { text: "Review task received." },
      { calls: [{ id: "report", name: "submit_report", input: { verdict: "done", summary: "SDK result verified." } }] },
      { text: "Awaiting review." },
      { text: "Review received." },
    ]),
  )
  const child = spawn(binary, ["serve", "--script", script], {
    env: { ...process.env, MERAKCODE_HOME: home },
    stdio: "ignore",
    windowsHide: true,
  })
  const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()))
  try {
    const infoFile = path.join(home, "data", "engine.json")
    let info: { endpoint: string; token: string } | undefined
    for (let attempt = 0; attempt < 250; attempt++) {
      if (child.exitCode !== null) throw new Error(`Engine exited with ${child.exitCode}`)
      info = await readFile(infoFile, "utf8")
        .then((text) => JSON.parse(text) as { endpoint: string; token: string })
        .catch(() => undefined)
      if (info) break
      await delay(20)
    }
    if (!info) throw new Error("Engine did not publish connection information")
    const client = await connect(info)
    try {
      expect(await client.agent.catalog()).toContainEqual({
        kind: "builtin",
        name: "MerakCode",
        available: true,
        caps: { steer: true, permission: true, mcp: false },
      })
      const created = await client.session.create({ provider: "fake", workdir: home })
      let view: Conversation | undefined
      const watching = await watchConversation(client, created.session, (value) => {
        view = value
      })
      const received: EngineEvent[] = []
      const done = Promise.withResolvers<void>()
      const stop = await client.events.subscribe({ scope: { session: created.session } }, (event) => {
        received.push(event)
        if (event.type === "turn.finished") done.resolve()
      })
      const other = await client.session.create({ provider: "fake", workdir: home })
      const unrelated: EngineEvent[] = []
      const stopOther = await client.events.subscribe({ scope: { session: other.session } }, (event) =>
        unrelated.push(event),
      )
      await client.session.send({ session: created.session, parts: [{ text: "Hello" }] })
      await Promise.race([
        done.promise,
        delay(5000).then(() => {
          throw new Error("Conversation did not finish")
        }),
      ])
      await stop()
      await stopOther()
      expect(unrelated).toEqual([])
      const completed = received.find((event) => event.type === "message.completed")
      expect(completed?.payload.parts?.[0]?.text).toBe("Hello from the SDK test.")
      expect(received.filter((event) => event.seq).map((event) => event.seq)).toEqual([2, 3, 4, 5, 6, 7])
      expect(received.filter((event) => event.type === "session.mcp_configured")).toHaveLength(1)
      await expect.poll(() => view?.state.status).toBe("done")
      expect(view?.state.messages?.at(-1)?.parts?.[0]?.text).toBe("Hello from the SDK test.")
      await watching.close()
      const restored = await watchConversation(client, created.session, (value) => {
        view = value
      })
      expect(view?.state.messages).toHaveLength(2)
      expect(view?.state.lastSeq).toBe(7)
      await restored.close()
      const logDir = path.join(home, "logs", "production", "desktop")
      await mkdir(logDir, { recursive: true })
      await writeFile(
        path.join(logDir, "fixture.ndjson"),
        JSON.stringify({ msg: "fixture", detail: randomBytes(2 << 20).toString("base64") }) + "\n",
      )
      const bundle = await client.diagnostics.bundle({})
      const archive = await client.blob.get(bundle.ref)
      expect(archive.byteLength).toBeGreaterThan(1 << 20)
      expect([...archive.subarray(0, 4)]).toEqual([0x50, 0x4b, 0x03, 0x04])
      expect(new TextDecoder().decode(archive)).toContain("versions.json")
      const diagnosticPath = path.join(home, "command-diagnostics.zip")
      await promisify(execFile)(binary, ["diagnose", "--session", created.session, "--out", diagnosticPath], {
        env: { ...process.env, MERAKCODE_HOME: home },
        windowsHide: true,
      })
      const commandArchive = await readFile(diagnosticPath)
      expect(commandArchive.subarray(0, 4)).toEqual(Buffer.from([0x50, 0x4b, 0x03, 0x04]))
      expect(commandArchive.includes(Buffer.from(`events/session-${created.session}.jsonl`))).toBe(true)
      await client.agent.save({
        agent: {
          id: "leader-agent",
          name: "Leader",
          role: "leader",
          summary: "Coordinate work",
          duties: "",
          model: { provider: "fake", model: "" },
          toolPool: "leader.default",
        },
      })
      const group = await client.group.create({
        id: "",
        kind: "local",
        name: "SDK group",
        project: { directory: home },
        leader: "leader",
        members: [
          { id: "local-human", group: "", kind: "human", name: "Owner", role: "owner", status: "idle" },
          {
            id: "leader",
            group: "",
            kind: "agent",
            name: "Leader",
            agentRole: "leader",
            agent: "leader-agent",
            status: "idle",
          },
        ],
      })
      const groupDone = Promise.withResolvers<void>()
      const stopGroup = await client.events.subscribe({ scope: { group: group.id } }, (event) => {
        if (event.type === "turn.finished") groupDone.resolve()
      })
      const task = await client.task.create({ group: group.id, title: "Verify the SDK group" })
      await Promise.race([
        groupDone.promise,
        delay(5000).then(() => {
          throw new Error("Group did not handle the task")
        }),
      ])
      const state = await client.group.state({ group: group.id })
      expect(state.goals?.[0]?.id).toBe(task.id)
      expect(state.lastSeq).toBeGreaterThan(0)
      await stopGroup()
      await client.agent.save({
        agent: {
          id: "worker-agent",
          name: "Worker",
          role: "worker",
          summary: "Do work",
          duties: "",
          model: { provider: "fake", model: "" },
          toolPool: "worker.default",
        },
      })
      await client.group.addMember({
        group: group.id,
        member: {
          id: "worker",
          group: group.id,
          kind: "agent",
          name: "Worker",
          agentRole: "worker",
          agent: "worker-agent",
          status: "idle",
        },
      })
      const groupEvents: EngineEvent[] = []
      const observeGroup = await client.events.subscribe({ scope: { group: group.id } }, (event) =>
        groupEvents.push(event),
      )
      const message = await client.group.say({ group: group.id, text: "Please prepare for review." })
      await expect.poll(() => groupEvents.filter((event) => event.type === "turn.finished").length).toBe(1)
      expect(groupEvents.some((event) => event.type === "notice.sent" && event.cause === message)).toBe(true)
      const reviewed = await client.task.create({
        group: group.id,

        title: "Review the SDK result",
        review: true,
      })
      await expect.poll(() => groupEvents.filter((event) => event.type === "turn.finished").length).toBe(2)
      const claim = await client.task.assign({ task: reviewed.id, member: "worker" })
      expect(claim.member).toBe("worker")
      await expect
        .poll(() => groupEvents.some((event) => event.type === "task.reported" && event.scope.task === reviewed.id))
        .toBe(true)
      await client.task.update({ task: reviewed.id, phase: "doing" })
      await client.task.update({ task: reviewed.id, phase: "integrating" })
      await expect
        .poll(() =>
          groupEvents.some(
            (event) =>
              event.type === "phase.changed" && event.scope.task === reviewed.id && event.payload.phase === "review",
          ),
        )
        .toBe(true)
      await client.task.review({ task: reviewed.id, decision: "approve" })
      await expect
        .poll(() => groupEvents.some((event) => event.type === "task.closed" && event.scope.task === reviewed.id))
        .toBe(true)
      await observeGroup()
      const shutdown = Promise.withResolvers<void>()
      await client.events.subscribe({ types: ["engine.shutdown"] }, () => shutdown.resolve())
      await client.engine.stop()
      await Promise.race([
        Promise.all([shutdown.promise, exited]),
        delay(5000).then(() => {
          throw new Error("Engine did not stop in order")
        }),
      ])
      expect(child.exitCode).toBe(0)
    } finally {
      await client.close()
    }
  } finally {
    child.kill()
    await exited
    await rm(home, { recursive: true, force: true })
  }
}, 30000)
