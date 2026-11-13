import { execFile } from "node:child_process"
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { mkdir, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { promisify } from "node:util"
import { createRoot } from "solid-js"
import { afterAll, afterEach, beforeAll, expect, test, vi } from "vitest"
import { engineFixture } from "../../test/engine"
import { persistent } from "../../lib/persistence"
import { encodeDir } from "../../lib/route"
import { client } from "../../state/client"
import { refreshBranches, unsavedReason } from "../../state/git"
import { restoreReviewProtection } from "./protection"

// The code editor is a browser component; a plain text model stands in for it. Everything else is real.
vi.mock("../../lib/monaco", () => ({
  monaco: {
    Uri: { parse: (value: string) => value },
    editor: {
      createModel: (initial: string) => {
        let value = initial
        const listeners: Array<() => void> = []
        return {
          getValue: () => value,
          setValue: (next: string) => {
            value = next
            listeners.forEach((listener) => listener())
          },
          onDidChangeContent: (listener: () => void) => listeners.push(listener),
          dispose() {},
        }
      },
    },
  },
}))

/** Whether two folders that differ only by case can both exist on the disk this test runs on. */
const caseSensitive = (() => {
  const probe = mkdtempSync(path.join(tmpdir(), "merak-protection-probe-"))
  writeFileSync(path.join(probe, "Probe.txt"), "")
  const result = !existsSync(path.join(probe, "probe.txt"))
  rmSync(probe, { recursive: true, force: true })
  return result
})()

let env: Awaited<ReturnType<typeof engineFixture>>
beforeAll(async () => {
  env = await engineFixture()
  location.href = env.url
  await writeFile(path.join(env.project, "note.txt"), "note\n")
  await env.git("add", ".")
  await env.git("commit", "-m", "initial")
}, 120_000)
afterAll(async () => {
  try {
    await (await client()).close()
  } finally {
    await env?.close()
  }
})

afterEach(() => {
  vi.restoreAllMocks()
  localStorage.clear()
})

let counter = 0
/** A real checkout with one commit, so its branch can be switched. */
async function checkout(name: string) {
  const directory = path.join(path.dirname(env.project), `${name}-${++counter}`)
  await mkdir(directory)
  const git = (...args: string[]) => promisify(execFile)("git", args, { cwd: directory, windowsHide: true })
  await git("init", "-b", "main")
  await git("config", "user.name", "Fixture")
  await git("config", "user.email", "fixture@example.invalid")
  await git("commit", "--allow-empty", "-m", "initial")
  return (await (await client()).file.identity({ directory, path: "." })).directory
}
/** A fresh generation of the window's modules, as after a reload. */
async function reload() {
  vi.resetModules()
  const [workspace, git, error] = await Promise.all([
    import("../panel/workspace"),
    import("../../state/git"),
    import("../../state/error"),
  ])
  return { ...workspace, ...git, summary: error.summary }
}
const pending = (directory: string, owner: string) => ({
  target: {
    key: "pending",
    directory,
    sessionID: owner,
    scope: "session" as const,
    file: "notes.txt",
    version: "v1",
    side: "new" as const,
    rows: [],
  },
  text: "Keep this feedback",
})

const encode = (value: string) => Buffer.from(value).toString("base64url")
/** A saved review panel of a sleeping conversation, with feedback pointing into a folder */
const sleepingReview = (owner: string, directory: string) =>
  persistent.set(
    `panels-${encode(owner)}`,
    "layout",
    JSON.stringify({
      version: 1,
      directory,
      tabs: [
        {
          id: "review-tab",
          kind: "review",
          view: {
            comments: {
              [owner]: [
                {
                  key: "k",
                  directory,
                  sessionID: owner,
                  scope: "turn",
                  file: "a.txt",
                  version: "v",
                  side: "new",
                  rows: [],
                },
              ],
            },
          },
        },
      ],
    }),
  )

test("saved feedback in a folder on a volume that is not there does not keep other folders from loading their branches", async () => {
  const offline = path.join(env.project, "..", "volume-that-is-gone", "old")
  await sleepingReview("offline-owner", offline)
  const options = await refreshBranches(env.project)
  expect(options?.branches.map((branch) => branch.name)).toContain("main")
  await restoreReviewProtection(env.project)
  expect(unsavedReason(env.project)).toBeUndefined()
})

test("saved feedback in a folder that is the same checkout blocks switching its branch", async () => {
  await sleepingReview("same-owner", env.project)
  await restoreReviewProtection(env.project)
  expect(unsavedReason(env.project)).toBeTruthy()
})

test("a damaged sleeping review layout keeps branch protection and reports a recovery code", async () => {
  const directory = await checkout("damaged-review")
  const bucket = `panels-${encodeDir("damaged-owner")}`
  await persistent.set(bucket, "layout", "{broken")
  const window = await reload()
  expect(await window.refreshBranches(directory)).toBeUndefined()
  expect(window.switchReason(directory)).toBeTruthy()
  expect(window.summary(window.gitState(directory)?.error)).toBe("MRK-4026")
  expect(await persistent.get(bucket, "layout")).toBe("{broken")
})

test("a branch change in a sibling worktree leaves the other worktree's draft and branch unchanged", async () => {
  const directory = await checkout(caseSensitive ? "Repo" : "repo-one")
  const sibling = await checkout(caseSensitive ? "repo" : "repo-two")
  const owner = (await (await client()).session.create({ provider: "fake", model: "test", workdir: directory })).session
  vi.resetModules()
  const { draftSnapshot, restoreDraftSnapshot } = await import("./compose")
  const { useReview, setReview, review, addComment, commentDirectory, commentsOf, remainingComments } =
    await import("./state")
  const { updateCheckout, identityOf } = await import("../../state/git")
  restoreDraftSnapshot({ pending: { ...pending(directory, owner), text: "Keep feedback" } })
  updateCheckout(directory, { branch: "main", head: "original-head", checkout: "main:original-head" })
  const dispose = createRoot((dispose) => {
    useReview(
      () => owner,
      () => directory,
      () => false,
    )
    return dispose
  })
  try {
    const target = draftSnapshot().pending!.target
    commentDirectory(owner, directory)
    addComment(owner, target, "Ready to send")
    addComment(owner, { ...target, directory: sibling }, "Other worktree feedback")
    setReview({ directory, commenting: target, selecting: target })
    updateCheckout(sibling, { branch: "feature", head: "other-head", checkout: "feature:other-head" }, true)
    expect(draftSnapshot().pending?.stale).not.toBe(true)
    expect(identityOf(directory)).toMatchObject({ branch: "main", head: "original-head" })
    expect(review.commenting).toEqual(target)
    expect(review.selecting).toEqual(target)
    expect(commentsOf(owner, directory).map((comment) => [comment.text, !!comment.stale])).toEqual([
      ["Ready to send", false],
    ])
    expect(remainingComments(commentsOf(owner), undefined, directory).map((comment) => comment.text)).toEqual([
      "Other worktree feedback",
    ])
  } finally {
    dispose()
  }
})

test.each([
  ["a linked folder", true],
  ["a sibling folder", false],
] as const)("sleeping review protection resolves %s before comparing it with the checkout", async (_title, linked) => {
  const target = await checkout(caseSensitive && !linked ? "Repo" : "review-checkout")
  const other = await checkout(caseSensitive ? "repo" : "review-sibling")
  const alias = path.join(path.dirname(env.project), `review-link-${++counter}`)
  await symlink(target, alias, "junction")
  const source = linked ? alias : other
  await persistent.set(
    `panels-${encodeDir("sleeping")}`,
    "layout",
    JSON.stringify({
      version: 1,
      directory: source,
      tabs: [{ id: "review", kind: "review", view: { drafts: { pending: { text: "Keep feedback" } } } }],
    }),
  )
  const window = await reload()
  await window.refreshBranches(target)
  expect(!!window.unsavedReason(target)).toBe(linked)
})

test("legacy review comments in a project subdirectory protect the whole checkout before their conversation is opened", async () => {
  const root = await checkout("legacy-review")
  await mkdir(path.join(root, "sub"))
  const sub = (await (await client()).file.identity({ directory: path.join(root, "sub"), path: "." })).directory
  await persistent.set(
    `panels-${encodeDir("legacy-owner")}`,
    "layout",
    JSON.stringify({
      version: 1,
      tabs: [
        {
          id: "review",
          kind: "review",
          view: {
            comments: {
              "legacy-owner": [
                {
                  id: 1,
                  key: "target",
                  text: "Pending feedback",
                  directory: sub,
                  sessionID: "legacy-owner",
                  scope: "session",
                  file: "notes.txt",
                  version: "v1",
                  side: "new",
                  rows: [],
                },
              ],
            },
          },
        },
      ],
    }),
  )
  const window = await reload()
  await window.refreshBranches(sub)
  expect(window.unsavedReason(sub)).toBeTruthy()
  await window.refreshBranches(root)
  expect(window.unsavedReason(root)).toBeTruthy()
})

test("a failed final review write keeps branch protection until the clear is durable", async () => {
  const directory = "/review-clear-failure"
  const window = await reload()
  const { persistent: storage } = await import("../../lib/persistence")
  const owner = await window.selectPanels({ directory, sessionID: "owner" })
  await window.openPanel({ kind: "review", view: { drafts: { pending: { text: "Unsaved feedback" } } } })
  await owner.flush()
  const fail = vi.spyOn(storage, "set").mockRejectedValueOnce(new Error("Clear unavailable"))
  await expect(owner.remove(owner.state.tabs[0]!.id)).rejects.toThrow("Clear unavailable")
  expect(window.unsavedReason(directory)).toBeTruthy()
  fail.mockRestore()
  await owner.flush()
  expect(window.unsavedReason(directory)).toBeUndefined()
})

test("a sleeping review draft blocks its worktree after reload until the last draft is discarded", async () => {
  const directory = await checkout("review-guard")
  const independent = await checkout("independent-tree")
  const before = await reload()
  const owner = await before.selectPanels({ directory, sessionID: "owner" })
  await before.openPanel({ kind: "review", view: { drafts: { pending: pending(directory, "owner") } } })
  await owner.flush()
  const after = await reload()
  await after.selectPanels({ directory, sessionID: "other" })
  await after.refreshBranches(directory)
  expect(after.switchReason(directory)).toBeTruthy()
  await after.refreshBranches(independent)
  expect(after.switchReason(independent)).toBeUndefined()
  const restored = await after.selectPanels({ directory, sessionID: "owner" })
  expect(restored.state.tabs[0]?.view?.drafts).toMatchObject({ pending: { text: "Keep this feedback" } })
  await restored.remove(restored.state.tabs[0]!.id)
  await after.refreshBranches(directory)
  expect(after.switchReason(directory)).toBeUndefined()
})
