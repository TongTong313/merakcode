import { execFileSync } from "node:child_process"
import path from "node:path"
import { access, chmod, rm, rmdir, symlink, unlink } from "node:fs/promises"
import { afterAll, beforeAll, expect, test } from "vitest"
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
  git("config", "user.name", "Branch Test")
  git("config", "user.email", "branch@example.test")
  await Filesystem.write(path.join(env.project, "branch.txt"), "main content\n")
  git("add", "branch.txt")
  git("commit", "--quiet", "-m", "initial")
  git("branch", "-M", "main")
  git("branch", "dev")
  merak = await createMerakCode({ cwd: env.project, executablePath: engine, env: env.env })
}, 120_000)

afterAll(async () => {
  await merak?.close()
  await model?.close()
  await env?.[Symbol.asyncDispose]()
})

test.each(["unstaged", "staged"] as const)(
  "refuses to switch with %s tracked changes and preserves them",
  async (kind) => {
    const { client } = merak
    const before = (await client.vcs.get({}, { throwOnError: true })).data
    const original = (await client.file.read({ path: "branch.txt" }, { throwOnError: true })).data.content
    const content = `${original}keep this tracked draft\n`
    try {
      await client.file.write({ path: "branch.txt", content }, { throwOnError: true })
      if (kind === "staged")
        expect(
          (await client.vcs.run({ args: ["add", "--", "branch.txt"] }, { throwOnError: true })).data.exitCode,
        ).toBe(0)
      const options = (await client.vcs.branchOptions({}, { throwOnError: true })).data
      expect(options.blocked).toMatchObject({ reason: "dirty", [kind]: 1 })
      const switched = await client.vcs.switchBranch({ branch: "dev", expectedCheckout: options.current!.checkout })
      expect(switched.response.status).toBe(409)
      expect(switched.error).toMatchObject({ name: "CheckoutBlockedError", data: { reason: "dirty" } })
      expect((await client.vcs.get({}, { throwOnError: true })).data).toMatchObject({
        branch: before.branch,
        checkout: before.checkout,
        [kind]: 1,
      })
      expect((await client.file.read({ path: "branch.txt" }, { throwOnError: true })).data.content).toBe(content)
    } finally {
      git("restore", "--source", before.head!, "--staged", "--worktree", "--", "branch.txt")
      git("switch", "--quiet", "main")
    }
  },
  120_000,
)

test("allows switching one checkout while another checkout in the same project is busy", async () => {
  const { client } = merak
  const created = (await client.worktree.create({ worktreeCreateInput: { base: "main" } }, { throwOnError: true })).data
  let entered = false
  let release!: () => void
  const waiting = new Promise<void>((resolve) => (release = resolve))
  let running: ReturnType<typeof client.session.prompt> | undefined
  reply = async () => {
    entered = true
    await waiting
    return { text: "finished" }
  }
  try {
    await expect
      .poll(async () => (await client.vcs.get({ directory: created.directory }, { throwOnError: true })).data.head, {
        timeout: 30_000,
      })
      .toEqual(expect.any(String))
    const session = (await client.session.create({ directory: created.directory }, { throwOnError: true })).data
    running = client.session.prompt({
      directory: created.directory,
      sessionID: session.id,
      permissionMode: "auto",
      parts: [{ type: "text", text: "Wait while the primary checkout switches branches" }],
    })
    await expect.poll(() => entered, { timeout: 30_000 }).toBe(true)
    const before = (await client.vcs.branchOptions({}, { throwOnError: true })).data.current!
    const switched = await client.vcs.switchBranch({ branch: "dev", expectedCheckout: before.checkout })
    expect(switched.response.status).toBe(200)
    expect((await client.vcs.get({}, { throwOnError: true })).data.branch).toBe("dev")
    expect((await client.vcs.get({ directory: created.directory }, { throwOnError: true })).data.branch).toBe(
      created.branch,
    )
  } finally {
    release()
    reply = () => ({ text: "OK" })
    await running
    git("switch", "--quiet", "main")
    await client.worktree.remove({ worktreeRemoveInput: { directory: created.directory } }, { throwOnError: true })
  }
}, 120_000)

test("reports branches used by another worktree and refuses to switch to them", async () => {
  const target = path.join(env.root, "occupied")
  git("worktree", "add", "--quiet", target, "dev")
  try {
    const { client } = merak
    const listed = (await client.vcs.branchOptions({}, { throwOnError: true })).data
    const switched = await client.vcs.switchBranch({ branch: "dev", expectedCheckout: listed.current!.checkout })
    expect(switched.response.status).toBe(409)
    expect(switched.error).toMatchObject({ name: "CheckoutBlockedError", data: { reason: "occupied" } })
    expect(listed.branches.find((branch) => branch.name === "dev")).toMatchObject({ worktree: target })
    expect((await client.vcs.get({}, { throwOnError: true })).data.branch).toBe("main")
  } finally {
    git("worktree", "remove", "--force", target)
  }
}, 120_000)

test("keeps a managed worktree bound to its branch", async () => {
  const { client } = merak
  const created = (await client.worktree.create({ worktreeCreateInput: { base: "main" } }, { throwOnError: true })).data
  try {
    await expect
      .poll(
        async () => {
          const status = (await client.vcs.get({ directory: created.directory }, { throwOnError: true })).data
          return status.staged + status.unstaged + status.untracked
        },
        { timeout: 30_000 },
      )
      .toBe(0)
    const listed = (await client.vcs.branchOptions({ directory: created.directory }, { throwOnError: true })).data
    const switched = await client.vcs.switchBranch({
      directory: created.directory,
      branch: "dev",
      expectedCheckout: listed.current!.checkout,
    })
    expect(switched.response.status).toBe(409)
    expect(switched.error).toMatchObject({ name: "CheckoutBlockedError", data: { reason: "managed_worktree" } })
    expect(listed.blocked?.reason).toBe("managed_worktree")
    expect((await client.vcs.get({ directory: created.directory }, { throwOnError: true })).data.branch).toBe(
      created.branch,
    )
  } finally {
    git("-C", created.directory, "switch", "--quiet", "--", created.branch)
    await client.worktree.remove({ worktreeRemoveInput: { directory: created.directory } }, { throwOnError: true })
  }
}, 120_000)

test("reports an unfinished merge and preserves it when switching is requested", async () => {
  git("switch", "--quiet", "-c", "merge-side", "main")
  await Filesystem.write(path.join(env.project, "branch.txt"), "their content\n")
  git("commit", "--quiet", "-am", "their change")
  git("switch", "--quiet", "-c", "merge-check", "main")
  await Filesystem.write(path.join(env.project, "branch.txt"), "our content\n")
  git("commit", "--quiet", "-am", "our change")
  try {
    git("merge", "--no-edit", "merge-side")
  } catch {
    // The fixture deliberately leaves a real merge conflict unresolved.
  }
  try {
    const { client } = merak
    const listed = (await client.vcs.branchOptions({}, { throwOnError: true })).data
    const switched = await client.vcs.switchBranch({ branch: "dev", expectedCheckout: listed.current!.checkout })
    expect(switched.response.status).toBe(409)
    expect(switched.error).toMatchObject({
      name: "CheckoutBlockedError",
      data: { reason: "git_operation", operation: "merge" },
    })
    expect(listed.blocked).toMatchObject({ reason: "git_operation", operation: "merge" })
    expect((await client.vcs.get({}, { throwOnError: true })).data.branch).toBe("merge-check")
  } finally {
    git("merge", "--abort")
    git("switch", "--quiet", "main")
    git("branch", "-D", "merge-check", "merge-side")
  }
}, 120_000)

test("explains an unborn checkout instead of switching it implicitly", async () => {
  git("switch", "--quiet", "--orphan", "unborn")
  try {
    const { client } = merak
    const listed = (await client.vcs.branchOptions({}, { throwOnError: true })).data
    const switched = await client.vcs.switchBranch({ branch: "dev", expectedCheckout: listed.current!.checkout })
    expect(switched.response.status).toBe(409)
    expect(switched.error).toMatchObject({ name: "CheckoutBlockedError", data: { reason: "unborn" } })
    expect(listed.blocked?.reason).toBe("unborn")
    expect((await client.vcs.get({}, { throwOnError: true })).data).toMatchObject({ branch: "unborn", head: null })
  } finally {
    git("switch", "--quiet", "main")
  }
}, 120_000)

test("explains that branch switching is unavailable while a session is running", async () => {
  let entered = false
  let release!: () => void
  const waiting = new Promise<void>((resolve) => (release = resolve))
  reply = async () => {
    entered = true
    await waiting
    return { text: "finished" }
  }
  const session = await merak.session()
  const running = (async () => {
    for await (const event of session.run("Wait for this request", { mode: "auto" })) void event
  })()
  try {
    await expect.poll(() => entered, { timeout: 30_000 }).toBe(true)
    const listed = (await merak.client.vcs.branchOptions({}, { throwOnError: true })).data
    expect(listed.blocked?.reason).toBe("busy")
  } finally {
    release()
    reply = () => ({ text: "OK" })
    await running
  }
}, 120_000)

test("publishes a new checkout context after a commit on the same branch", async () => {
  const { client } = merak
  const before = (await client.vcs.get({}, { throwOnError: true })).data
  const abort = new AbortController()
  const events = await client.event.subscribe(undefined, { signal: abort.signal })
  let updated:
    { branch: string | null; head: string | null; checkout: string | null; branchChanged: boolean } | undefined
  const collecting = (async () => {
    for await (const event of events.stream)
      if (event.type === "vcs.head.updated" && event.properties.head !== before.head) updated = event.properties
  })().catch(() => {})
  try {
    await client.file.write({ path: "branch.txt", content: "committed content\n" }, { throwOnError: true })
    const committed = (await client.vcs.commit({ message: "SDK commit", all: true }, { throwOnError: true })).data
    expect(committed.ok).toBe(true)
    await expect.poll(() => updated, { timeout: 3000 }).toMatchObject({ branch: "main", branchChanged: false })
    expect(updated!.checkout).not.toBe(before.checkout)
    expect((await client.vcs.get({}, { throwOnError: true })).data.checkout).toBe(updated!.checkout)
  } finally {
    abort.abort()
    await collecting
  }
}, 120_000)

test("publishes a new checkout context after a Git command advances HEAD", async () => {
  const { client } = merak
  const before = (await client.vcs.get({}, { throwOnError: true })).data
  const abort = new AbortController()
  const events = await client.event.subscribe(undefined, { signal: abort.signal })
  let updated:
    { branch: string | null; head: string | null; checkout: string | null; branchChanged: boolean } | undefined
  const collecting = (async () => {
    for await (const event of events.stream)
      if (event.type === "vcs.head.updated" && event.properties.head !== before.head) updated = event.properties
  })().catch(() => {})
  try {
    const run = (
      await client.vcs.run(
        { args: ["commit", "--quiet", "--allow-empty", "-m", "Git command commit"] },
        { throwOnError: true },
      )
    ).data
    expect(run.exitCode).toBe(0)
    await expect.poll(() => updated, { timeout: 3000 }).toMatchObject({ branch: "main", branchChanged: false })
    expect(updated!.checkout).not.toBe(before.checkout)
    expect((await client.vcs.get({}, { throwOnError: true })).data.checkout).toBe(updated!.checkout)
  } finally {
    abort.abort()
    await collecting
  }
}, 120_000)

test("observes a same-branch commit made outside the engine", async () => {
  const { client } = merak
  const before = (await client.vcs.get({}, { throwOnError: true })).data
  const abort = new AbortController()
  const events = await client.event.subscribe(undefined, { signal: abort.signal })
  let updated:
    { branch: string | null; head: string | null; checkout: string | null; branchChanged: boolean } | undefined
  const collecting = (async () => {
    for await (const event of events.stream)
      if (event.type === "vcs.head.updated" && event.properties.head !== before.head) updated = event.properties
  })().catch(() => {})
  try {
    git("commit", "--quiet", "--allow-empty", "-m", "external commit")
    await expect.poll(() => updated, { timeout: 5000 }).toMatchObject({ branch: "main", branchChanged: false })
    expect(updated!.checkout).not.toBe(before.checkout)
    expect((await client.vcs.get({}, { throwOnError: true })).data.checkout).toBe(updated!.checkout)
  } finally {
    abort.abort()
    await collecting
  }
}, 120_000)

test("observes shared branch refs for a linked worktree without changing the main checkout context", async () => {
  const { client } = merak
  const created = (await client.worktree.create({ worktreeCreateInput: { base: "main" } }, { throwOnError: true })).data
  const abort = new AbortController()
  let collecting: Promise<void> | undefined
  try {
    await expect
      .poll(
        async () => {
          const status = (await client.vcs.get({ directory: created.directory }, { throwOnError: true })).data
          return status.staged + status.unstaged + status.untracked
        },
        { timeout: 30_000 },
      )
      .toBe(0)
    const primary = (await client.vcs.get({}, { throwOnError: true })).data
    const before = (await client.vcs.get({ directory: created.directory }, { throwOnError: true })).data
    const events = await client.event.subscribe({ directory: created.directory }, { signal: abort.signal })
    let updated:
      { branch: string | null; head: string | null; checkout: string | null; branchChanged: boolean } | undefined
    collecting = (async () => {
      for await (const event of events.stream)
        if (event.type === "vcs.head.updated" && event.properties.head !== before.head) updated = event.properties
    })().catch(() => {})
    git("-C", created.directory, "commit", "--quiet", "--allow-empty", "-m", "linked commit")
    await expect.poll(() => updated, { timeout: 5000 }).toMatchObject({ branch: created.branch, branchChanged: false })
    expect(updated!.checkout).not.toBe(before.checkout)
    expect((await client.vcs.get({}, { throwOnError: true })).data.checkout).toBe(primary.checkout)
  } finally {
    abort.abort()
    await collecting
    await client.worktree.remove({ worktreeRemoveInput: { directory: created.directory } }, { throwOnError: true })
  }
}, 120_000)

test("does not switch the checkout while its push is still running", async () => {
  const remote = path.join(env.root, "push-remote.git")
  const hook = path.join(env.project, ".git", "hooks", "pre-push")
  const script = path.join(env.root, "push-hook.mjs")
  const ready = path.join(env.root, "push-ready")
  const release = path.join(env.root, "push-release")
  const quote = (value: string) => `'${value.replace(/\\/g, "/").replaceAll("'", "'\\''")}'`
  git("init", "--bare", "--quiet", remote)
  git("remote", "add", "origin", remote)
  await Filesystem.write(
    script,
    `import { access, writeFile } from "node:fs/promises"\nimport { setTimeout } from "node:timers/promises"\nawait writeFile(${JSON.stringify(ready)}, "ready")\nfor (;;) {\n  if (await access(${JSON.stringify(release)}).then(() => true, () => false)) break\n  await setTimeout(10)\n}\n`,
  )
  await Filesystem.write(hook, `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(script)}\n`)
  await chmod(hook, 0o755)
  const { client } = merak
  const before = (await client.vcs.branchOptions({}, { throwOnError: true })).data.current!
  const pushing = client.vcs.push({}, { throwOnError: true })
  void pushing.catch(() => {})
  try {
    await expect
      .poll(
        () =>
          access(ready).then(
            () => true,
            () => false,
          ),
        { timeout: 30_000 },
      )
      .toBe(true)
    const switched = await client.vcs.switchBranch({ branch: "dev", expectedCheckout: before.checkout })
    expect(switched.response.status).toBe(409)
    expect((await client.vcs.get({}, { throwOnError: true })).data.branch).toBe("main")
  } finally {
    await Filesystem.write(release, "release")
    await pushing
    await rm(hook, { force: true })
    git("switch", "--quiet", "main")
    git("remote", "remove", "origin")
  }
}, 120_000)

test("keeps old contexts stale after a round trip through a branch at the same commit", async () => {
  const { client } = merak
  git("branch", "same-head", "main")
  try {
    const before = (await client.vcs.get({}, { throwOnError: true })).data
    const other = (
      await client.vcs.switchBranch({ branch: "same-head", expectedCheckout: before.checkout! }, { throwOnError: true })
    ).data
    expect(other.head).toBe(before.head)
    expect(other.checkout).not.toBe(before.checkout)
    const restored = (
      await client.vcs.switchBranch({ branch: "main", expectedCheckout: other.checkout }, { throwOnError: true })
    ).data
    expect(restored.checkout).not.toBe(before.checkout)
    const stale = await client.vcs.switchBranch({ branch: "dev", expectedCheckout: before.checkout! })
    expect(stale.response.status).toBe(409)
    expect(stale.error).toMatchObject({ name: "CheckoutStaleError" })
    expect((await client.vcs.get({}, { throwOnError: true })).data.branch).toBe("main")
  } finally {
    git("switch", "--quiet", "main")
    git("branch", "-D", "same-head")
  }
}, 120_000)

test("leaves the checkout token unchanged when its current branch is selected", async () => {
  const { client } = merak
  const before = (await client.vcs.get({}, { throwOnError: true })).data
  const switched = (
    await client.vcs.switchBranch({ branch: "main", expectedCheckout: before.checkout! }, { throwOnError: true })
  ).data
  expect(switched).toMatchObject({ branch: "main", changed: false, checkout: before.checkout })
}, 120_000)

test("returns from detached HEAD to an existing local branch", async () => {
  const { client } = merak
  git("switch", "--quiet", "--detach", "main")
  try {
    const listed = (await client.vcs.branchOptions({}, { throwOnError: true })).data
    expect(listed.current).toMatchObject({ branch: null, head: expect.any(String) })
    expect(listed.blocked).toBeUndefined()
    const switched = (
      await client.vcs.switchBranch(
        { branch: "dev", expectedCheckout: listed.current!.checkout },
        { throwOnError: true },
      )
    ).data
    expect(switched).toMatchObject({ branch: "dev", changed: true })
    expect((await client.vcs.get({}, { throwOnError: true })).data.branch).toBe("dev")
  } finally {
    git("switch", "--quiet", "main")
  }
}, 120_000)

test("refuses a target deleted after the branch list was read", async () => {
  const { client } = merak
  git("branch", "deleted-target", "main")
  const listed = (await client.vcs.branchOptions({}, { throwOnError: true })).data
  git("branch", "-D", "deleted-target")
  const switched = await client.vcs.switchBranch({
    branch: "deleted-target",
    expectedCheckout: listed.current!.checkout,
  })
  expect(switched.response.status).toBe(400)
  expect(switched.error).toMatchObject({ name: "VcsInvalidBranchError" })
  expect((await client.vcs.get({}, { throwOnError: true })).data.branch).toBe("main")
}, 120_000)

test("shares checkout identity and active work through a directory alias", async () => {
  const alias = path.join(env.root, "project-alias")
  await symlink(env.project, alias, process.platform === "win32" ? "junction" : "dir")
  let entered = false
  let release!: () => void
  const waiting = new Promise<void>((resolve) => (release = resolve))
  reply = async () => {
    entered = true
    await waiting
    return { text: "finished" }
  }
  const session = await merak.session()
  const running = (async () => {
    for await (const event of session.run("Wait while the alias is inspected", { mode: "auto" })) void event
  })()
  try {
    await expect.poll(() => entered, { timeout: 30_000 }).toBe(true)
    const primary = (await merak.client.vcs.get({}, { throwOnError: true })).data
    const listed = (await merak.client.vcs.branchOptions({ directory: alias }, { throwOnError: true })).data
    expect(listed.current?.checkout).toBe(primary.checkout)
    expect(listed.blocked?.reason).toBe("busy")
    const switched = await merak.client.vcs.switchBranch({
      directory: alias,
      branch: "dev",
      expectedCheckout: listed.current!.checkout,
    })
    expect(switched.response.status).toBe(409)
    expect((await merak.client.vcs.get({}, { throwOnError: true })).data.branch).toBe("main")
  } finally {
    release()
    reply = () => ({ text: "OK" })
    await running
    if (process.platform === "win32") await rmdir(alias)
    else await unlink(alias)
  }
}, 120_000)
