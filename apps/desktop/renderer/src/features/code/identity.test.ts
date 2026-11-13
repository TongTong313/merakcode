import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { mkdir, rename, symlink, unlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { afterAll, afterEach, beforeAll, expect, test, vi } from "vitest"
import { engineFixture } from "../../test/engine"
import { persistent } from "../../lib/persistence"
import { encodeDir } from "../../lib/route"
import { client } from "../../state/client"

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

/** What the disk this test runs on can tell apart; the engine reports the disk's own spelling. */
const probe = mkdtempSync(path.join(tmpdir(), "merak-identity-probe-"))
writeFileSync(path.join(probe, "Probe.txt"), "")
writeFileSync(path.join(probe, "café.txt"), "")
const caseSensitive = !existsSync(path.join(probe, "probe.txt"))
const normalizing = existsSync(path.join(probe, "café.txt"))
rmSync(probe, { recursive: true, force: true })

let env: Awaited<ReturnType<typeof engineFixture>>
let engine: Awaited<ReturnType<typeof client>>
let counter = 0
beforeAll(async () => {
  env = await engineFixture()
  location.href = env.url
  engine = await client()
}, 120_000)
afterAll(async () => {
  try {
    const { client: current } = await import("../../state/client")
    await (await current()).close()
    await engine.close()
  } finally {
    await env?.close()
  }
})
afterEach(() => {
  vi.restoreAllMocks()
  localStorage.clear()
})

/** Directory records are keyed by the forward-slash spelling of a folder. */
const slashes = (directory: string) => directory.replace(/\\/g, "/")
const base = () => path.dirname(env.project)
const fresh = (name: string) => path.join(base(), `${name}-${++counter}`)
/** The canonical form of a folder, exactly as the engine names it. */
const canonical = async (directory: string) => (await engine.file.identity({ directory, path: "." })).directory
/** A real folder. */
async function folder(name: string) {
  const directory = fresh(name)
  await mkdir(directory)
  return canonical(directory)
}
/** A linked folder: another spelling of the same checkout. */
async function link(target: string, name = "link") {
  const alias = fresh(name)
  await symlink(target, alias, "junction")
  return alias
}
/** Points a link somewhere else, as a retargeted link or a reconnected volume does. */
async function relink(alias: string, target: string) {
  await unlink(alias).catch(() => {})
  await symlink(target, alias, "junction")
}
/** A folder that is not reachable until `online` is called, like a removed volume. */
const offline = (directory: string) => rename(directory, `${directory}.away`)
const online = (directory: string) => rename(`${directory}.away`, directory)
const chat = async () =>
  (await engine.session.create({ provider: "fake", model: "test", workdir: env.project })).session
/** Forgets what the window confirmed about every directory, as data written before directory records did. */
async function forgetDirectories() {
  for (const [key] of await persistent.entries("file-directories")) await persistent.remove("file-directories", key)
}

/** A fresh generation of the renderer's modules: what a window reload runs. */
async function load() {
  vi.resetModules()
  const [workspace, git, drafts, references, identity, state] = await Promise.all([
    import("../panel/workspace"),
    import("../../state/git"),
    import("./draft"),
    import("./references"),
    import("./identity"),
    import("../review/state"),
  ])
  return { ...workspace, ...git, ...drafts, ...references, ...identity, review: state }
}

const rows = [{ kind: "add" as const, text: "original", new: 1, hunk: "h1", index: 0 }]

test.each(["draft", "comment"].flatMap((kind) => [false, true].map((legacy) => ({ kind, legacy }))))(
  "review-only $kind protection survives an offline actual root with legacy=$legacy",
  async ({ kind, legacy }) => {
    const actual = await folder("offline-actual-root")
    const directory = await link(actual, "review-only-offline")
    const healthy = await folder("healthy-review-checkout")
    const owner = `review-only-owner-${kind}-${legacy}`
    const first = await load()
    await first.selectPanels({ directory, sessionID: owner })
    expect(await first.refreshBranches(directory)).toBeDefined()
    first.review.beginComment(directory, owner, "notes.txt", "v1", rows)
    const target = first.review.review.commenting!
    expect(target.directory).toBe(actual)
    if (kind === "comment") first.review.addComment(owner, target, "keep offline feedback")
    await first.openPanel({
      kind: "review",
      view:
        kind === "draft"
          ? { drafts: { pending: { text: "keep offline feedback", target } } }
          : { comments: { [owner]: first.review.commentsOf(owner) } },
    })
    expect(first.unsavedReason(directory)).toBeTruthy()
    const bucket = `panels-${encodeDir(owner)}`
    const raw = await persistent.get(bucket, "layout")
    expect(raw).toContain("keep offline feedback")
    if (legacy) await forgetDirectories()
    await unlink(directory)
    await offline(actual)
    for (let reload = 0; reload < 2; reload++) {
      const git = await load()
      expect(await git.refreshBranches(healthy)).toBeDefined()
      expect(git.unsavedReason(healthy)).toBeUndefined()
      expect(await persistent.get(bucket, "layout")).toBe(raw)
    }
    await online(actual)
    await symlink(actual, directory, "junction")
    const git = await load()
    expect(await git.refreshBranches(directory)).toBeDefined()
    expect(git.unsavedReason(directory)).toBeTruthy()
  },
)

test.each(
  ["draft", "comment"].flatMap((kind) =>
    [false, true].flatMap((open) => [false, true].map((legacy) => ({ kind, open, legacy }))),
  ),
)(
  "a retargeted review-only link retains its $kind ownership with open=$open and legacy=$legacy",
  async ({ kind, open, legacy }) => {
    const original = await folder("review-original")
    const replacement = await folder("review-replacement")
    const alias = await link(original, "review-retarget-link")
    const owner = `review-retarget-owner-${kind}-${open}-${legacy}`
    const first = await load()
    await first.selectPanels({ directory: alias, sessionID: owner })
    expect(await first.refreshBranches(alias)).toBeDefined()
    first.review.beginComment(alias, owner, "notes.txt", "v1", rows)
    const target = first.review.review.commenting!
    expect(target.directory).toBe(original)
    if (kind === "comment") first.review.addComment(owner, target, "original feedback")
    await first.openPanel({
      kind: "review",
      view:
        kind === "draft"
          ? { drafts: { pending: { text: "original feedback", target } } }
          : { comments: { [owner]: first.review.commentsOf(owner) } },
    })
    const bucket = `panels-${encodeDir(owner)}`
    const raw = await persistent.get(bucket, "layout")
    if (legacy) await forgetDirectories()
    await relink(alias, replacement)
    const git = await load()
    if (open)
      await expect(git.selectPanels({ directory: alias, sessionID: owner })).rejects.toMatchObject({
        code: "MRK-5023",
      })
    expect(await git.refreshBranches(alias)).toBeUndefined()
    expect(git.gitState(alias)?.error?.cause).toMatchObject({ code: "MRK-5023" })
    expect(await git.refreshBranches(original)).toBeDefined()
    expect(git.unsavedReason(original)).toBeTruthy()
    expect(await git.refreshBranches(replacement)).toBeDefined()
    expect(git.unsavedReason(replacement)).toBeUndefined()
    expect(await persistent.get(bucket, "layout")).toBe(raw)
  },
)

test("a failed review directory confirmation retains feedback and blocks branch switching until retry", async () => {
  const directory = await folder("review-confirmation-retry")
  const owner = "confirmation-owner"
  const first = await load()
  const { summary } = await import("../../state/error")
  await first.selectPanels({ directory, sessionID: owner })
  await first.openPanel({
    kind: "review",
    view: { drafts: { pending: { text: "retained feedback", target: { directory } } } },
  })
  const bucket = `panels-${encodeDir(owner)}`
  const raw = await persistent.get(bucket, "layout")
  const write = localStorage.setItem.bind(localStorage)
  const failure = vi.spyOn(localStorage, "setItem").mockImplementation((key, value) => {
    if (key.startsWith("file-directories:")) throw new Error("storage unavailable")
    write(key, value)
  })
  try {
    expect(await first.refreshBranches(directory)).toBeUndefined()
    expect(summary(first.gitState(directory)?.error)).toBe("MRK-4025")
    expect(first.switchReason(directory)).toBeTruthy()
    expect(await persistent.get(bucket, "layout")).toBe(raw)
  } finally {
    failure.mockRestore()
  }
  expect(await first.refreshBranches(directory)).toBeDefined()
  expect(first.switchReason(directory)).toBeTruthy()
  expect(await persistent.get(bucket, "layout")).toBe(raw)
})

test("an offline confirmed directory does not block another checkout after repeated reloads", async () => {
  const directory = await folder("removable-project")
  const healthy = await folder("healthy-checkout")
  const first = await load()
  await first.selectPanels({ directory, sessionID: "offline-owner" })
  await first.openPanel({ kind: "file", path: "notes.txt" })
  await first.writeDraft(directory, "notes.txt", { content: "keep offline edits", saved: "original" })
  await first.openPanel({
    kind: "review",
    view: { drafts: { pending: { text: "keep feedback", target: { directory } } } },
  })
  await first.flushPanels()
  await offline(directory)
  for (let reload = 0; reload < 2; reload++) {
    const generation = await load()
    expect(await generation.refreshBranches(healthy)).toBeDefined()
    expect(generation.unsavedReason(healthy)).toBeUndefined()
    expect(await generation.readDraft(healthy, "notes.txt")).toBeUndefined()
    expect(await generation.fileOwners(healthy, "notes.txt")).toEqual([])
    expect(await persistent.get(`draft-${encodeDir(directory)}`, "notes.txt")).toContain("keep offline edits")
  }
  await online(directory)
  const restored = await load()
  expect(await restored.readDraft(directory, "notes.txt")).toMatchObject({ content: "keep offline edits" })
  expect(await restored.fileOwners(directory, "notes.txt")).toEqual(["offline-owner"])
})

test("an offline alias retains its sleeping draft guard and unknown legacy roots fail closed", async () => {
  const directory = await folder("protected-checkout")
  const other = await folder("other-worktree")
  const alias = await link(directory, "protected-link")
  const first = await load()
  await first.resolveFile(alias, "notes.txt")
  const raw = JSON.stringify({ version: 1, content: "sleeping edits", saved: "original" })
  await persistent.set(`draft-${encodeDir(alias)}`, "notes.txt", raw)
  await unlink(alias)
  const git = await load()
  expect(await git.refreshBranches(directory)).toBeDefined()
  expect(git.unsavedReason(directory)).toBeTruthy()
  expect(await git.refreshBranches(other)).toBeDefined()
  expect(git.unsavedReason(other)).toBeUndefined()
  await symlink(directory, alias, "junction")
  expect(await git.readDraft(directory, "notes.txt")).toMatchObject({ content: "sleeping edits" })
  await git.writeDraft(directory, "notes.txt")
  await git.refreshBranches(directory)
  expect(git.unsavedReason(directory)).toBeUndefined()
  const unknown = fresh("unknown-offline")
  await persistent.set(`draft-${encodeDir(unknown)}`, "notes.txt", raw)
  expect(await git.readDraft(directory, "notes.txt")).toBeUndefined()
  expect(await persistent.get(`draft-${encodeDir(unknown)}`, "notes.txt")).toBe(raw)
  await mkdir(unknown)
  expect(await git.refreshBranches(directory)).toBeDefined()
  expect(await git.readDraft(await canonical(unknown), "notes.txt")).toMatchObject({ content: "sleeping edits" })
})

test("legacy checkout identities isolate an offline draft before any new directory metadata exists", async () => {
  const directory = await folder("legacy-checkout")
  const healthy = await folder("healthy-legacy-checkout")
  const alias = await link(directory, "legacy-offline-link")
  await unlink(alias)
  await persistent.set(
    `draft-${encodeDir(alias)}`,
    "notes.txt",
    JSON.stringify({
      version: 1,
      content: "legacy edits",
      saved: "original",
      identity: { directory, branch: "main", head: "original-head" },
    }),
  )
  await persistent.set(`file-links-${encodeDir(alias)}`, "notes.txt", JSON.stringify(["legacy-owner"]))
  const git = await load()
  expect(await git.refreshBranches(healthy)).toBeDefined()
  expect(await git.readDraft(healthy, "notes.txt")).toBeUndefined()
  expect(await git.fileOwners(healthy, "notes.txt")).toEqual([])
  expect(await git.refreshBranches(directory)).toBeDefined()
  expect(git.unsavedReason(directory)).toBeTruthy()
  await symlink(directory, alias, "junction")
  expect(await git.readDraft(directory, "notes.txt")).toMatchObject({ content: "legacy edits" })
  expect(await git.fileOwners(directory, "notes.txt")).toEqual(["legacy-owner"])
})

test("a draft kept for a subdirectory is not merged with a same-named file of the checkout root", async () => {
  const root = await folder("subdirectory-repo")
  await mkdir(path.join(root, "sub"))
  const directory = await canonical(path.join(root, "sub"))
  const first = await load()
  await first.resolveFile(directory, "notes.txt")
  await persistent.set(
    `draft-${encodeDir(directory)}`,
    "notes.txt",
    JSON.stringify({ version: 1, content: "subdirectory edits", saved: "original" }),
  )
  await persistent.set(`file-links-${encodeDir(directory)}`, "notes.txt", '["subdirectory-owner"]')
  const git = await load()
  expect(await git.readDraft(root, "notes.txt")).toBeUndefined()
  expect(await git.fileOwners(root, "notes.txt")).toEqual([])
  expect(await git.readDraft(root, "sub/notes.txt")).toBeUndefined()
  expect(await git.readDraft(directory, "notes.txt")).toMatchObject({ content: "subdirectory edits" })
  expect(await git.fileOwners(directory, "notes.txt")).toEqual(["subdirectory-owner"])
})

test.each(["{broken", "42"])("damaged directory metadata %s is retained with a recovery error", async (raw) => {
  const directory = await folder("damaged-directory-metadata")
  const healthy = await folder("healthy-metadata")
  await persistent.set("file-directories", slashes(directory), raw)
  const draft = JSON.stringify({ version: 1, content: "retained edits", saved: "original" })
  await persistent.set(`draft-${encodeDir(directory)}`, "notes.txt", draft)
  const git = await load()
  expect(await git.readDraft(healthy, "notes.txt")).toBeUndefined()
  await expect(git.readDraft(directory, "notes.txt")).rejects.toMatchObject({ code: "MRK-5023" })
  expect(await persistent.get("file-directories", slashes(directory))).toBe(raw)
  expect(await persistent.get(`draft-${encodeDir(directory)}`, "notes.txt")).toBe(draft)
})

test.each([
  { git: false, legacy: false },
  { git: true, legacy: false },
  { git: true, legacy: true },
])(
  "a retargeted root link preserves its old drafts and owners with Git=$git and legacy=$legacy",
  async ({ git, legacy }) => {
    const original = await folder("original-root")
    const next = await folder("replacement-root")
    const alias = await link(original, "retargeted-link")
    const owner = `old-owner-${git}-${legacy}`
    const first = await load()
    await first.resolveFile(alias, "notes.txt")
    if (legacy) await forgetDirectories()
    const draft = JSON.stringify({
      version: 1,
      content: "original edits",
      saved: "original",
      identity: git ? { directory: original, branch: "main", head: "head" } : null,
    })
    await persistent.set(`draft-${encodeDir(alias)}`, "notes.txt", draft)
    await persistent.set(`file-links-${encodeDir(alias)}`, "notes.txt", `["${owner}"]`)
    const layout = JSON.stringify({
      version: 1,
      directory: alias,
      tabs: [{ id: "old-file", kind: "file", path: "notes.txt", fileDirectory: alias }],
    })
    await persistent.set(`panels-${encodeDir(owner)}`, "layout", layout)
    await relink(alias, next)
    const moved = await load()
    await expect(moved.selectPanels({ directory: alias, sessionID: owner })).rejects.toMatchObject({
      code: "MRK-5023",
    })
    expect(await persistent.get(`draft-${encodeDir(alias)}`, "notes.txt")).toBe(draft)
    expect(await persistent.get(`panels-${encodeDir(owner)}`, "layout")).toBe(layout)
    expect(await moved.readDraft(next, "notes.txt")).toBeUndefined()
    expect(await moved.fileOwners(next, "notes.txt")).toEqual([])
    await relink(alias, original)
    const restored = await load()
    await restored.selectPanels({ directory: alias, sessionID: owner })
    expect(await restored.readDraft(original, "notes.txt")).toMatchObject({ content: "original edits" })
  },
)

test("a restored root link recovers legacy drafts and sleeping file owners", async () => {
  const directory = await folder("plain-project")
  const other = await folder("other-plain-project")
  const alias = await link(directory, "plain-link")
  const workspace = await load()
  await persistent.set(
    `draft-${encodeDir(alias)}`,
    "notes.txt",
    JSON.stringify({ version: 1, content: "legacy edits", saved: "original" }),
  )
  await persistent.set(`file-links-${encodeDir(alias)}`, "notes.txt", JSON.stringify(["active", "sleeping"]))
  await persistent.set(
    `panels-${encodeDir("active")}`,
    "layout",
    JSON.stringify({
      version: 1,
      directory: alias,
      visible: true,
      selected: "legacy-file",
      tabs: [{ id: "legacy-file", kind: "file", path: "notes.txt", fileDirectory: alias }],
    }),
  )
  const panels = await workspace.selectPanels({ directory: alias, sessionID: "active" })
  const selected = panels.state.tabs.find((tab) => tab.id === panels.state.selected)!
  expect(selected).toMatchObject({ id: "legacy-file", path: "notes.txt", fileDirectory: directory })
  expect
    .soft(await workspace.readDraft(selected.fileDirectory!, selected.path!))
    .toMatchObject({ content: "legacy edits" })
  expect.soft((await workspace.fileOwners(directory, "notes.txt")).sort()).toEqual(["active", "sleeping"])
  expect(await workspace.readDraft(other, "notes.txt")).toBeUndefined()
  expect(await workspace.fileOwners(other, "notes.txt")).toEqual([])
})

test("a legacy self-mapping requires an explicit recovery choice after its link reconnects", async () => {
  const directory = await folder("reconnected-project")
  const elsewhere = await folder("changed-again")
  const alias = fresh("old-missing-link")
  const draft = JSON.stringify({ version: 1, content: "recover old edits", saved: "original", identity: null })
  const refs = '["old-owner","sleeping-owner"]'
  await persistent.set("file-directories", slashes(alias), JSON.stringify(alias))
  await persistent.set(`draft-${encodeDir(alias)}`, "notes.txt", draft)
  await persistent.set(`file-links-${encodeDir(alias)}`, "notes.txt", refs)
  await symlink(directory, alias, "junction")
  const first = await load()
  await expect(first.readDraft(directory, "notes.txt")).rejects.toMatchObject({
    code: "MRK-5023",
    data: { directory: alias, actual: directory, previous: alias, recoverable: true },
  })
  expect(await persistent.get(`draft-${encodeDir(alias)}`, "notes.txt")).toBe(draft)
  expect(await persistent.get(`file-links-${encodeDir(alias)}`, "notes.txt")).toBe(refs)
  const error = await first.readDraft(directory, "notes.txt").catch((error: unknown) => error)
  const choice = first.directoryRecovery(error)!
  expect(choice).toBeDefined()
  await relink(alias, elsewhere)
  await expect(first.recoverDirectory(choice)).rejects.toMatchObject({ code: "MRK-5023" })
  expect(await persistent.get(`draft-${encodeDir(alias)}`, "notes.txt")).toBe(draft)
  await relink(alias, directory)
  await first.recoverDirectory(choice)
  for (let reload = 0; reload < 2; reload++) {
    const generation = await load()
    expect(await generation.readDraft(directory, "notes.txt")).toMatchObject({ content: "recover old edits" })
    expect(await generation.fileOwners(directory, "notes.txt")).toEqual(["old-owner", "sleeping-owner"])
    expect(await generation.retainFile(directory, "notes.txt", "old-owner")).toEqual(["old-owner", "sleeping-owner"])
    expect(await persistent.entries(`draft-${encodeDir(alias)}`)).toEqual([])
    expect(await persistent.entries(`file-links-${encodeDir(alias)}`)).toEqual([])
  }
})

test.each(["draft-", "file-links-"])(
  "root recovery preserves %s records through a failed canonical write and repeated reloads",
  async (prefix) => {
    const directory = await folder("plain-retry")
    const separate = await folder("separate-plain-retry")
    const alias = await link(directory, "plain-retry-link")
    const primary = JSON.stringify({ version: 1, content: "canonical edits", saved: "original" })
    const legacy = JSON.stringify({ version: 1, content: "legacy edits", saved: "original" })
    await persistent.set(`draft-${encodeDir(directory)}`, "notes.txt", primary)
    await persistent.set(`draft-${encodeDir(alias)}`, "notes.txt", legacy)
    await persistent.set(`file-links-${encodeDir(directory)}`, "notes.txt", JSON.stringify(["active"]))
    await persistent.set(`file-links-${encodeDir(alias)}`, "notes.txt", JSON.stringify(["sleeping"]))
    const setItem = localStorage.setItem.bind(localStorage)
    const failure = vi.spyOn(localStorage, "setItem").mockImplementation((key, value) => {
      if (key === `${prefix}${encodeDir(directory)}:notes.txt`) throw new Error("storage unavailable")
      return setItem(key, value)
    })
    try {
      const generation = await load()
      await expect(
        prefix === "draft-"
          ? generation.readDraft(directory, "notes.txt")
          : generation.retainFile(directory, "notes.txt", "active"),
      ).rejects.toMatchObject({ code: "MRK-4025", cause: { message: "storage unavailable" } })
      expect(await persistent.get(`draft-${encodeDir(directory)}`, "notes.txt")).toBe(primary)
      expect(await persistent.get(`draft-${encodeDir(alias)}`, "notes.txt")).toBe(legacy)
      expect(await persistent.get(`file-links-${encodeDir(directory)}`, "notes.txt")).toBe('["active"]')
      expect(await persistent.get(`file-links-${encodeDir(alias)}`, "notes.txt")).toBe('["sleeping"]')
    } finally {
      failure.mockRestore()
    }
    for (let reload = 0; reload < 2; reload++) {
      const generation = await load()
      expect(await generation.readDraft(directory, "notes.txt")).toMatchObject({
        content: "canonical edits",
        alternatives: [{ content: "legacy edits" }],
      })
      expect(await generation.fileOwners(directory, "notes.txt")).toEqual(["active", "sleeping"])
      expect(await generation.retainFile(directory, "notes.txt", "active")).toEqual(["active", "sleeping"])
      expect(await persistent.entries(`draft-${encodeDir(alias)}`)).toEqual([])
      expect(await persistent.entries(`file-links-${encodeDir(alias)}`)).toEqual([])
      expect(await generation.readDraft(separate, "notes.txt")).toBeUndefined()
      expect(await generation.fileOwners(separate, "notes.txt")).toEqual([])
    }
  },
)

test("a retired source retries its legacy transfer without duplicating file tabs", async () => {
  const directory = await folder("plain-transfer")
  const alias = await link(directory, "plain-transfer-link")
  const source = `new:${alias}`
  const target = { directory: alias, sessionID: await chat() }
  const snapshot = {
    version: 1,
    directory: alias,
    visible: true,
    selected: "source-file",
    tabs: [{ id: "source-file", kind: "file", path: "notes.txt", fileDirectory: alias }],
  }
  await persistent.set(`panels-${encodeDir(source)}`, "layout", JSON.stringify(snapshot))
  await persistent.set(
    `panels-${encodeDir(target.sessionID)}`,
    "layout",
    JSON.stringify({
      ...snapshot,
      selected: "target-file",
      tabs: [{ id: "target-file", kind: "file", path: "notes.txt", fileDirectory: alias }],
    }),
  )
  await persistent.set(
    "panel-transfers",
    target.sessionID,
    JSON.stringify({ version: 1, sourceContext: { directory: alias }, target, snapshot }),
  )
  await persistent.set(
    `draft-${encodeDir(alias)}`,
    "notes.txt",
    JSON.stringify({ version: 1, content: "transfer draft", saved: "original" }),
  )
  await persistent.set(`file-links-${encodeDir(alias)}`, "notes.txt", JSON.stringify([source, "sleeping"]))
  const removeItem = localStorage.removeItem.bind(localStorage)
  const failure = vi.spyOn(localStorage, "removeItem").mockImplementation((key) => {
    if (key === `panel-transfers:${target.sessionID}`) throw new Error("journal cleanup unavailable")
    return removeItem(key)
  })
  try {
    const workspace = await load()
    await expect(workspace.selectPanels(target)).rejects.toMatchObject({
      code: "MRK-4025",
      cause: { message: "journal cleanup unavailable" },
    })
    expect(JSON.parse((await persistent.get(`panels-${encodeDir(source)}`, "layout"))!).tabs).toEqual([])
    expect(await persistent.get("panel-transfers", target.sessionID)).toBeTruthy()
  } finally {
    failure.mockRestore()
  }
  for (let restart = 0; restart < 2; restart++) {
    const workspace = await load()
    const restored = await workspace.selectPanels(target)
    expect(restored.state.tabs).toMatchObject([{ id: "target-file", fileDirectory: directory, path: "notes.txt" }])
    expect(restored.state.selected).toBe("target-file")
    expect(await workspace.readDraft(directory, "notes.txt")).toMatchObject({ content: "transfer draft" })
    expect((await workspace.fileOwners(directory, "notes.txt")).sort()).toEqual(["sleeping", target.sessionID].sort())
    expect(await persistent.entries("panel-transfers")).toEqual([])
  }
})

test("sleeping sibling aliases recover draft protection, contents and owners before branch switching", async () => {
  const directory = await folder("checkout")
  const independent = await folder("independent-checkout")
  const alias = await link(directory, "sibling-link")
  const git = await load()
  await persistent.set(
    `draft-${encodeDir(alias)}`,
    "notes.txt",
    JSON.stringify({ version: 1, content: "keep me", saved: "original" }),
  )
  await persistent.set(`file-links-${encodeDir(alias)}`, "notes.txt", JSON.stringify(["sleeping"]))
  await git.refreshBranches(directory)
  expect(git.unsavedReason(directory)).toBeTruthy()
  expect(await git.readDraft(directory, "notes.txt")).toMatchObject({ content: "keep me" })
  expect(await git.fileOwners(directory, "notes.txt")).toEqual(["sleeping"])
  await git.refreshBranches(independent)
  expect(git.unsavedReason(independent)).toBeUndefined()
  await git.writeDraft(directory, "notes.txt")
  await git.refreshBranches(directory)
  expect(git.unsavedReason(directory)).toBeUndefined()
  expect(await persistent.entries(`draft-${encodeDir(alias)}`)).toEqual([])
})

test.skipIf(caseSensitive)("a case-only rename reuses the live file key and its draft", async () => {
  const directory = await folder("renamed-file")
  await writeFile(path.join(directory, "Notes.txt"), "original")
  const first = await load()
  const panels = await first.selectPanels({ directory, sessionID: "renamed" })
  await first.openPanel({ kind: "file", path: "Notes.txt" })
  const id = panels.state.selected
  await first.writeDraft(directory, "Notes.txt", { content: "unfinished", saved: "original" })
  await rename(path.join(directory, "Notes.txt"), path.join(directory, "notes.txt"))
  await first.openPanel({ kind: "file", path: "notes.txt" })
  expect(panels.state.tabs).toHaveLength(1)
  expect(panels.state.selected).toBe(id)
  expect(await first.readDraft(directory, "notes.txt")).toMatchObject({ content: "unfinished" })
  const restored = await load()
  const next = await restored.selectPanels({ directory, sessionID: "renamed" })
  expect(next.state.tabs[0]?.path).toBe("notes.txt")
  expect(await restored.readDraft(directory, "notes.txt")).toMatchObject({ content: "unfinished" })
})

test.skipIf(normalizing)("distinct Unicode filenames remain distinct when the engine confirms both", async () => {
  const directory = await folder("unicode-files")
  await writeFile(path.join(directory, "café.txt"), "composed")
  await writeFile(path.join(directory, "café.txt"), "decomposed")
  const workspace = await load()
  const panels = await workspace.selectPanels({ directory, sessionID: "unicode" })
  await workspace.openPanel({ kind: "file", path: "café.txt" })
  await workspace.openPanel({ kind: "file", path: "café.txt" })
  expect(panels.state.tabs.map((tab) => tab.path)).toEqual(["café.txt", "café.txt"])
})

test("an absolute path outside the folder reaches the engine unchanged", async () => {
  const directory = await folder(caseSensitive ? "Repo" : "repo-root")
  const sibling = await folder(caseSensitive ? "repo" : "repo-sibling")
  await writeFile(path.join(sibling, "notes.txt"), "elsewhere")
  const workspace = await load()
  const panels = await workspace.selectPanels({ directory, sessionID: "absolute-root" })
  const absolute = `${slashes(sibling)}/notes.txt`
  await workspace.openPanel({ kind: "file", path: absolute })
  expect(panels.state.tabs[0]?.path).toBe(absolute)
})

test("failed identity resolution preserves legacy data and retries without duplicating drafts", async () => {
  const directory = await folder("identity-retry")
  await writeFile(path.join(directory, "Notes.txt"), "original")
  const bucket = `panels-${encodeDir("retry-chat")}`
  const raw = JSON.stringify({
    version: 1,
    directory,
    tabs: [{ id: "file", kind: "file", path: "notes.txt", fileDirectory: directory }],
  })
  const draft = JSON.stringify({ version: 1, content: "keep me", saved: "original" })
  await persistent.set(bucket, "layout", raw)
  await persistent.set(`draft-${encodeDir(directory)}`, "notes.txt", draft)
  const spelled = caseSensitive ? "notes.txt" : "Notes.txt"
  await offline(directory)
  const first = await load()
  await expect(first.selectPanels({ directory, sessionID: "retry-chat" })).rejects.toThrow()
  expect(await persistent.get(bucket, "layout")).toBe(raw)
  expect(await persistent.get(`draft-${encodeDir(directory)}`, "notes.txt")).toBe(draft)
  await online(directory)
  expect((await first.selectPanels({ directory, sessionID: "retry-chat" })).state.tabs[0]?.path).toBe(spelled)
  expect(await first.readDraft(directory, spelled)).toMatchObject({ content: "keep me" })
  const restored = await load()
  await restored.selectPanels({ directory, sessionID: "retry-chat" })
  expect(await restored.readDraft(directory, spelled)).toMatchObject({ content: "keep me" })
  expect(await persistent.entries(`draft-${encodeDir(directory)}`)).toHaveLength(1)
})

test("worktrees with similar directory names keep separate tabs and owners", async () => {
  const upper = await folder(caseSensitive ? "Repo" : "Repo-one")
  const lower = await folder(caseSensitive ? "repo" : "repo-two")
  const workspace = await load()
  const panels = await workspace.selectPanels({ directory: upper, sessionID: "roots" })
  await workspace.openPanel({ kind: "file", path: "notes.txt", fileDirectory: upper })
  await workspace.openPanel({ kind: "file", path: "notes.txt", fileDirectory: lower })
  expect(panels.state.tabs).toHaveLength(2)
  expect(panels.state.tabs.map((tab) => tab.fileDirectory)).toEqual([upper, lower])
  expect(await workspace.fileOwners(upper, "notes.txt")).toEqual(["roots"])
  expect(await workspace.fileOwners(lower, "notes.txt")).toEqual(["roots"])
})

test("restored file identities retain drafts and owners whichever way the disk folds case", async () => {
  const directory = await folder("restored-identities")
  await writeFile(path.join(directory, "Notes.txt"), "original")
  if (caseSensitive) await writeFile(path.join(directory, "notes.txt"), "original")
  const workspace = await load()
  for (const [file, content, owner] of [
    ["Notes.txt", "Upper draft", "chat-a"],
    ["notes.txt", "Lower draft", "chat-b"],
  ] as const) {
    await persistent.set(
      `draft-${encodeDir(directory)}`,
      file,
      JSON.stringify({ version: 1, content, saved: "original" }),
    )
    await persistent.set(`file-links-${encodeDir(directory)}`, file, JSON.stringify([owner]))
  }
  await persistent.set(
    `panels-${encodeDir("chat-b")}`,
    "layout",
    JSON.stringify({
      version: 1,
      selected: "lower",
      visible: true,
      tabs: [
        { id: "upper", kind: "file", path: "Notes.txt" },
        { id: "lower", kind: "file", path: "notes.txt" },
      ],
    }),
  )
  const panels = await workspace.selectPanels({ directory, sessionID: "chat-b" })
  expect(panels.state.tabs).toHaveLength(caseSensitive ? 2 : 1)
  expect(panels.state.selected).toBe("lower")
  const selected = panels.state.tabs.find((tab) => tab.id === "lower")!
  const draft = await workspace.readDraft(directory, selected.path!)
  if (caseSensitive) {
    expect(draft?.content).toBe("Lower draft")
    expect(await workspace.fileOwners(directory, selected.path!)).toEqual(["chat-b"])
    return
  }
  expect(selected.path).toBe("Notes.txt")
  expect(draft?.content).toBe("Upper draft")
  expect(draft?.alternatives?.map((value) => value.content)).toEqual(["Lower draft"])
  expect((await workspace.fileOwners(directory, selected.path!)).sort()).toEqual(["chat-a", "chat-b"])
  await workspace.openPanel({ kind: "file", path: "notes.txt" })
  expect(panels.state.selected).toBe("lower")
})

test.each(["draft", "reference"])("an offline legacy %s leaves a distinct healthy checkout usable", async (kind) => {
  const old = fresh("legacy-nongit")
  const healthy = await folder("healthy-worktree")
  const bucket = (kind === "draft" ? "draft-" : "file-links-") + encodeDir(old)
  const raw =
    kind === "draft"
      ? JSON.stringify({ version: 1, content: "Legacy unsaved text", saved: "Original text", identity: null })
      : JSON.stringify(["offline-owner"])
  await persistent.set(bucket, "notes.txt", raw)
  const git = await load()
  const refresh = await git.refreshBranches(healthy)
  expect.soft(refresh, "Healthy checkout branch options should load").toBeDefined()
  expect.soft(git.gitState(healthy)?.error, "Healthy checkout should have no unrelated recovery error").toBeUndefined()
  const draft = await git.readDraft(healthy, "notes.txt").catch((error: unknown) => error)
  expect.soft(draft, "Healthy checkout should not inherit another draft or its error").toBeUndefined()
  const owners = await git.fileOwners(healthy, "notes.txt").catch((error: unknown) => error)
  expect.soft(owners, "Healthy checkout should not inherit another file reference or its error").toEqual([])
  expect(await persistent.get(bucket, "notes.txt")).toBe(raw)
  await mkdir(old)
  expect(await git.refreshBranches(healthy)).toBeDefined()
  expect(await git.readDraft(healthy, "notes.txt")).toBeUndefined()
  expect(await git.fileOwners(healthy, "notes.txt")).toEqual([])
  expect(await persistent.get(bucket, "notes.txt")).toBe(raw)
})
