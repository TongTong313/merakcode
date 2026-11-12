import { writeFile } from "node:fs/promises"
import path from "node:path"
import { createRoot } from "solid-js"
import { afterAll, beforeAll, expect, test } from "vitest"
import { engineFixture } from "../../test/engine"
import { client } from "../../state/client"
import { connect, listen, state } from "../../state/store"
import { useGitChanges } from "./changes"
import { identityOf, updateCheckout } from "../../state/git"
import { useReview } from "../review/state"
import { localHuman } from "../../state/groups"

let env: Awaited<ReturnType<typeof engineFixture>>
beforeAll(async () => {
  env = await engineFixture()
  location.href = env.url
  await env.git("commit", "--allow-empty", "-m", "Fixture")
}, 120_000)
afterAll(async () => {
  try {
    await (await client()).close()
  } finally {
    await env?.close()
  }
})

test("one failing observer does not discard later session events", async () => {
  const disconnect = connect()
  const seen: string[] = []
  const stopBroken = listen((_directory, event) => {
    if (event.type === "session.created") throw new Error("Observer failure")
  })
  const stopSeen = listen((_directory, event) => seen.push(event.type))
  try {
    await expect.poll(() => state.config).not.toBeUndefined()
    const connection = await client()
    const created = await connection.session.create({ provider: "fake", workdir: env.project })
    await connection.session.send({ session: created.session, parts: [{ text: "Hello" }] })
    await expect.poll(() => seen).toContain("turn.finished")
    expect(seen).toContain("session.created")
  } finally {
    const closed = (await client()).closed
    stopBroken()
    stopSeen()
    disconnect()
    await closed
  }
})

test("a refresh arriving during the initial Git load preserves its result", async () => {
  await writeFile(path.join(env.project, "new.txt"), "new\n")
  const connection = await client()
  const status = await connection.repo.status({ directory: env.project })
  const { changes, dispose } = createRoot((dispose) => ({ changes: useGitChanges(() => env.project), dispose }))
  try {
    updateCheckout(env.project, {
      branch: status.branch,
      head: status.head,
      checkout: `${status.branch}:${status.head}`,
    })
    await expect
      .poll(
        () => ({
          error: changes.error()?.message,
          loading: changes.loading(),
          files: [...(changes.data()?.staged ?? []), ...(changes.data()?.unstaged ?? [])].map((file) => file.file),
        }),
        { timeout: 5000 },
      )
      .toEqual({ error: undefined, loading: false, files: ["new.txt"] })
  } finally {
    dispose()
  }
})

test("external file changes and commits refresh Git and review views", async () => {
  const disconnect = connect()
  const connection = await client()
  const profiles = await connection.agent.list({})
  const leader = await connection.agent.save({
    agent: { ...profiles![0]!, id: "", model: { provider: "fake", model: "fixture" } },
  })
  await connection.group.create({
    id: "",
    kind: "local",
    name: "Watched project",
    project: { directory: env.project },
    leader: "leader",
    settings: { initiative: "passive" },
    members: [
      { id: localHuman, group: "", kind: "human", name: "Owner", role: "owner", status: "idle" },
      {
        id: "leader",
        group: "",
        kind: "agent",
        name: "Leader",
        agentRole: "leader",
        agent: leader.id,
        status: "idle",
      },
    ],
  })
  const base = await env.git("rev-parse", "HEAD")
  const { changes, review, dispose } = createRoot((dispose) => ({
    changes: useGitChanges(() => env.project),
    review: useReview(
      () => undefined,
      () => env.project,
      () => true,
      () => base,
    ),
    dispose,
  }))
  try {
    await expect.poll(() => review.data(), { timeout: 5000 }).toBeDefined()
    await writeFile(path.join(env.project, "watched.txt"), "External file\n")
    await expect
      .poll(() => (changes.data()?.unstaged ?? []).map((file) => file.file), { timeout: 10_000 })
      .toContain("watched.txt")
    await expect.poll(() => review.data()?.files.map((file) => file.file), { timeout: 3000 }).toContain("watched.txt")
    await env.git("add", "watched.txt")
    await env.git("commit", "-m", "External commit")
    const head = await env.git("rev-parse", "HEAD")
    await expect.poll(() => identityOf(env.project)?.head, { timeout: 10_000 }).toBe(head)
    await expect.poll(() => (changes.data()?.unstaged ?? []).map((file) => file.file)).not.toContain("watched.txt")
  } finally {
    dispose()
    const closed = connection.closed
    disconnect()
    await closed
  }
}, 30_000)
