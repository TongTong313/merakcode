import { afterEach, expect, test, vi } from "vitest"

let sensitive = false
let unavailable = false
let nonGit = false
let spelling = "Notes.txt"
const directories = new Map<string, string>()
const offsets = new Map<string, string>()
const offline = new Set<string>()
vi.mock("undici", () => ({
  Agent: class {},
  fetch: async (input: string, init?: { headers?: HeadersInit }) => {
    const url = new URL(input)
    const requestedDirectory = decodeURIComponent(new Headers(init?.headers).get("x-merakcode-directory")!)
    if (offline.has(requestedDirectory))
      return Response.json(
        { name: "UnknownError", code: "MRK-9000", data: { message: "Directory offline" } },
        { status: 500 },
      )
    const directory = directories.get(requestedDirectory) ?? requestedDirectory
    if (url.pathname === "/file/identity") {
      if (unavailable) return new Response("unavailable", { status: 503 })
      const inputPath = url.searchParams.get("path")!
      const alias = [...directories].find(
        ([alias, root]) => root === directory && inputPath.startsWith(`${alias}/`),
      )?.[0]
      const requested =
        (offsets.get(requestedDirectory) ?? "") + (alias ? inputPath.slice(alias.length + 1) : inputPath)
      return Response.json({
        directory,
        path: !sensitive && requested.toLowerCase() === "notes.txt" ? spelling : requested,
      })
    }
    return Response.json({
      directory: nonGit ? requestedDirectory : directory,
      branches: [],
      current: null,
      ...(nonGit ? { blocked: { reason: "not_git" } } : {}),
    })
  },
}))

afterEach(() => {
  vi.restoreAllMocks()
  localStorage.clear()
  spelling = "Notes.txt"
  directories.clear()
  offsets.clear()
  offline.clear()
  nonGit = false
})

test.each(["draft", "comment"].flatMap((kind) => [false, true].map((legacy) => ({ kind, legacy }))))(
  "review-only $kind protection survives an offline actual root with legacy=$legacy",
  async ({ kind, legacy }) => {
    vi.resetModules()
    sensitive = true
    unavailable = false
    const directory = "/review-only-offline"
    const actual = "/offline-actual-root"
    directories.set(directory, actual)
    const { selectPanels, openPanel } = await import("../panel/workspace")
    const { refreshBranches, unsavedReason } = await import("../../state/git")
    const { persistent } = await import("../../lib/persistence")
    const { encodeDir } = await import("../../lib/route")
    const owner = "review-only-owner"
    await selectPanels({ directory, sessionID: owner })
    expect(await refreshBranches(directory)).toBeDefined()
    const { beginComment, review, addComment, commentsOf } = await import("../review/state")
    beginComment(directory, owner, "notes.txt", "v1", [{ kind: "add", text: "original", new: 1, hunk: "h1", index: 0 }])
    const target = review.commenting!
    expect(target.directory).toBe(actual)
    if (kind === "comment") addComment(owner, target, "keep offline feedback")
    await openPanel({
      kind: "review",
      view:
        kind === "draft"
          ? { drafts: { pending: { text: "keep offline feedback", target } } }
          : { comments: { [owner]: commentsOf(owner) } },
    })
    expect(unsavedReason(directory)).toBeTruthy()
    const bucket = `panels-${encodeDir(owner)}`
    const raw = await persistent.get(bucket, "layout")
    expect(raw).toContain("keep offline feedback")
    if (legacy) {
      await persistent.remove("file-directories", directory)
      await persistent.remove("file-directories", actual)
    }
    offline.add(directory)
    offline.add(actual)
    for (let reload = 0; reload < 2; reload++) {
      vi.resetModules()
      const git = await import("../../state/git")
      expect(await git.refreshBranches("/healthy-review-checkout")).toBeDefined()
      expect(git.unsavedReason("/healthy-review-checkout")).toBeUndefined()
      expect(await persistent.get(bucket, "layout")).toBe(raw)
    }
    offline.clear()
    const git = await import("../../state/git")
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
    vi.resetModules()
    sensitive = true
    unavailable = false
    const alias = "/review-retarget-link"
    const original = "/review-original"
    const replacement = "/review-replacement"
    directories.set(alias, original)
    const { refreshBranches } = await import("../../state/git")
    const { selectPanels, openPanel } = await import("../panel/workspace")
    const { persistent } = await import("../../lib/persistence")
    const { encodeDir } = await import("../../lib/route")
    await selectPanels({ directory: alias, sessionID: "review-retarget-owner" })
    expect(await refreshBranches(alias)).toBeDefined()
    const { beginComment, review, addComment, commentsOf } = await import("../review/state")
    beginComment(alias, "review-retarget-owner", "notes.txt", "v1", [
      { kind: "add", text: "original", new: 1, hunk: "h1", index: 0 },
    ])
    const target = review.commenting!
    expect(target.directory).toBe(original)
    if (kind === "comment") addComment("review-retarget-owner", target, "original feedback")
    await openPanel({
      kind: "review",
      view:
        kind === "draft"
          ? { drafts: { pending: { text: "original feedback", target } } }
          : { comments: { "review-retarget-owner": commentsOf("review-retarget-owner") } },
    })
    const bucket = `panels-${encodeDir("review-retarget-owner")}`
    const raw = await persistent.get(bucket, "layout")
    if (legacy) await persistent.remove("file-directories", alias)
    directories.set(alias, replacement)
    vi.resetModules()
    const git = await import("../../state/git")
    if (open) {
      const restored = await import("../panel/workspace")
      await expect(
        restored.selectPanels({ directory: alias, sessionID: "review-retarget-owner" }),
      ).rejects.toMatchObject({
        code: "MRK-7015",
      })
    }
    expect(await git.refreshBranches(alias)).toBeUndefined()
    expect(git.gitState(alias)?.error?.cause).toMatchObject({ code: "MRK-7015" })
    expect(await git.refreshBranches(original)).toBeDefined()
    expect(git.unsavedReason(original)).toBeTruthy()
    expect(await git.refreshBranches(replacement)).toBeDefined()
    expect(git.unsavedReason(replacement)).toBeUndefined()
    expect(await persistent.get(bucket, "layout")).toBe(raw)
  },
)

test("a failed review directory confirmation retains feedback and blocks branch switching until retry", async () => {
  vi.resetModules()
  sensitive = true
  unavailable = false
  const directory = "/review-confirmation-retry"
  const { selectPanels, openPanel } = await import("../panel/workspace")
  const { refreshBranches, gitState, switchReason } = await import("../../state/git")
  const { summary } = await import("../../state/error")
  const { persistent } = await import("../../lib/persistence")
  const { encodeDir } = await import("../../lib/route")
  await selectPanels({ directory, sessionID: "confirmation-owner" })
  await openPanel({
    kind: "review",
    view: { drafts: { pending: { text: "retained feedback", target: { directory } } } },
  })
  const bucket = `panels-${encodeDir("confirmation-owner")}`
  const raw = await persistent.get(bucket, "layout")
  const write = localStorage.setItem.bind(localStorage)
  const failure = vi.spyOn(localStorage, "setItem").mockImplementation((key, value) => {
    if (key === `file-directories:${directory}`) throw new Error("storage unavailable")
    write(key, value)
  })
  try {
    expect(await refreshBranches(directory)).toBeUndefined()
    expect(summary(gitState(directory)?.error)).toBe("MRK-4018")
    expect(switchReason(directory)).toBeTruthy()
    expect(await persistent.get(bucket, "layout")).toBe(raw)
  } finally {
    failure.mockRestore()
  }
  expect(await refreshBranches(directory)).toBeDefined()
  expect(switchReason(directory)).toBeTruthy()
  expect(await persistent.get(bucket, "layout")).toBe(raw)
})

test("an offline confirmed directory does not block another checkout after repeated reloads", async () => {
  vi.resetModules()
  sensitive = true
  unavailable = false
  const directory = "/removable-project"
  const { selectPanels, openPanel } = await import("../panel/workspace")
  const { writeDraft } = await import("./draft")
  const { persistent } = await import("../../lib/persistence")
  const { encodeDir } = await import("../../lib/route")
  await selectPanels({ directory, sessionID: "offline-owner" })
  await openPanel({ kind: "file", path: "notes.txt" })
  await writeDraft(directory, "notes.txt", { content: "keep offline edits", saved: "original" })
  await openPanel({ kind: "review", view: { drafts: { pending: { text: "keep feedback", target: { directory } } } } })
  offline.add(directory)
  for (let reload = 0; reload < 2; reload++) {
    vi.resetModules()
    const { refreshBranches, unsavedReason } = await import("../../state/git")
    const { readDraft } = await import("./draft")
    const { fileOwners } = await import("./references")
    expect(await refreshBranches("/healthy-checkout")).toBeDefined()
    expect(unsavedReason("/healthy-checkout")).toBeUndefined()
    expect(await readDraft("/healthy-checkout", "notes.txt")).toBeUndefined()
    expect(await fileOwners("/healthy-checkout", "notes.txt")).toEqual([])
    expect(await persistent.get(`draft-${encodeDir(directory)}`, "notes.txt")).toContain("keep offline edits")
  }
  offline.clear()
  const { readDraft } = await import("./draft")
  const { fileOwners } = await import("./references")
  expect(await readDraft(directory, "notes.txt")).toMatchObject({ content: "keep offline edits" })
  expect(await fileOwners(directory, "notes.txt")).toEqual(["offline-owner"])
})

test("an offline alias retains its sleeping draft guard and unknown legacy roots fail closed", async () => {
  vi.resetModules()
  sensitive = true
  unavailable = false
  const directory = "/protected-checkout"
  const alias = "/protected-link"
  directories.set(alias, directory)
  const { resolveFile } = await import("./identity")
  const { persistent } = await import("../../lib/persistence")
  const { encodeDir } = await import("../../lib/route")
  await resolveFile(alias, "notes.txt")
  const raw = JSON.stringify({ version: 1, content: "sleeping edits", saved: "original" })
  await persistent.set(`draft-${encodeDir(alias)}`, "notes.txt", raw)
  offline.add(alias)
  vi.resetModules()
  const { refreshBranches, unsavedReason } = await import("../../state/git")
  expect(await refreshBranches(directory)).toBeDefined()
  expect(unsavedReason(directory)).toBeTruthy()
  expect(await refreshBranches("/other-worktree")).toBeDefined()
  expect(unsavedReason("/other-worktree")).toBeUndefined()
  offline.delete(alias)
  const { readDraft, writeDraft } = await import("./draft")
  expect(await readDraft(directory, "notes.txt")).toMatchObject({ content: "sleeping edits" })
  await writeDraft(directory, "notes.txt")
  await refreshBranches(directory)
  expect(unsavedReason(directory)).toBeUndefined()
  const unknown = "/unknown-offline"
  offline.add(unknown)
  await persistent.set(`draft-${encodeDir(unknown)}`, "notes.txt", raw)
  expect(await readDraft(directory, "notes.txt")).toBeUndefined()
  expect(await persistent.get(`draft-${encodeDir(unknown)}`, "notes.txt")).toBe(raw)
  offline.clear()
  expect(await refreshBranches(directory)).toBeDefined()
  expect(await readDraft(unknown, "notes.txt")).toMatchObject({ content: "sleeping edits" })
})

test("legacy checkout identities isolate an offline draft before any new directory metadata exists", async () => {
  vi.resetModules()
  sensitive = true
  unavailable = false
  const alias = "/legacy-offline-link"
  const directory = "/legacy-checkout"
  directories.set(alias, directory)
  offline.add(alias)
  const { persistent } = await import("../../lib/persistence")
  const { encodeDir } = await import("../../lib/route")
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
  const { refreshBranches, unsavedReason } = await import("../../state/git")
  const { readDraft } = await import("./draft")
  const { fileOwners } = await import("./references")
  expect(await refreshBranches("/healthy-legacy-checkout")).toBeDefined()
  expect(await readDraft("/healthy-legacy-checkout", "notes.txt")).toBeUndefined()
  expect(await fileOwners("/healthy-legacy-checkout", "notes.txt")).toEqual([])
  expect(await refreshBranches(directory)).toBeDefined()
  expect(unsavedReason(directory)).toBeTruthy()
  offline.delete(alias)
  expect(await readDraft(directory, "notes.txt")).toMatchObject({ content: "legacy edits" })
  expect(await fileOwners(directory, "notes.txt")).toEqual(["legacy-owner"])
})

test("a persisted subdirectory mapping cannot merge its draft with a same-named root file", async () => {
  vi.resetModules()
  sensitive = true
  unavailable = false
  const root = "/subdirectory-repo"
  const directory = `${root}/sub`
  directories.set(directory, root)
  offsets.set(directory, "sub/")
  const { resolveFile } = await import("./identity")
  await resolveFile(directory, "notes.txt")
  const { persistent } = await import("../../lib/persistence")
  const { encodeDir } = await import("../../lib/route")
  await persistent.set(
    `draft-${encodeDir(directory)}`,
    "notes.txt",
    JSON.stringify({ version: 1, content: "subdirectory edits", saved: "original" }),
  )
  await persistent.set(`file-links-${encodeDir(directory)}`, "notes.txt", '["subdirectory-owner"]')
  vi.resetModules()
  const { readDraft } = await import("./draft")
  const { fileOwners } = await import("./references")
  expect(await readDraft(root, "notes.txt")).toBeUndefined()
  expect(await fileOwners(root, "notes.txt")).toEqual([])
  expect(await readDraft(root, "sub/notes.txt")).toMatchObject({ content: "subdirectory edits" })
  expect(await fileOwners(root, "sub/notes.txt")).toEqual(["subdirectory-owner"])
})

test.each(["{broken", "42"])("damaged directory metadata %s is retained with a recovery error", async (raw) => {
  vi.resetModules()
  sensitive = true
  unavailable = false
  const directory = "/damaged-directory-metadata"
  const { persistent } = await import("../../lib/persistence")
  const { encodeDir } = await import("../../lib/route")
  await persistent.set("file-directories", directory, raw)
  const draft = JSON.stringify({ version: 1, content: "retained edits", saved: "original" })
  await persistent.set(`draft-${encodeDir(directory)}`, "notes.txt", draft)
  const { readDraft } = await import("./draft")
  expect(await readDraft("/healthy-metadata", "notes.txt")).toBeUndefined()
  await expect(readDraft(directory, "notes.txt")).rejects.toMatchObject({ code: "MRK-7015" })
  expect(await persistent.get("file-directories", directory)).toBe(raw)
  expect(await persistent.get(`draft-${encodeDir(directory)}`, "notes.txt")).toBe(draft)
})

test.each([
  { git: false, legacy: false },
  { git: true, legacy: false },
  { git: true, legacy: true },
])(
  "a retargeted root link preserves its old drafts and owners with Git=$git and legacy=$legacy",
  async ({ git, legacy }) => {
    vi.resetModules()
    sensitive = true
    unavailable = false
    nonGit = !git
    const alias = "/retargeted-link"
    const original = "/original-root"
    const next = "/replacement-root"
    directories.set(alias, original)
    const { resolveFile } = await import("./identity")
    const { persistent } = await import("../../lib/persistence")
    const { encodeDir } = await import("../../lib/route")
    await resolveFile(alias, "notes.txt")
    if (legacy) await persistent.remove("file-directories", alias)
    const draft = JSON.stringify({
      version: 1,
      content: "original edits",
      saved: "original",
      identity: git ? { directory: original, branch: "main", head: "head" } : null,
    })
    await persistent.set(`draft-${encodeDir(alias)}`, "notes.txt", draft)
    await persistent.set(`file-links-${encodeDir(alias)}`, "notes.txt", '["old-owner"]')
    const layout = JSON.stringify({
      version: 1,
      directory: alias,
      tabs: [{ id: "old-file", kind: "file", path: "notes.txt", fileDirectory: alias }],
    })
    await persistent.set(`panels-${encodeDir("old-owner")}`, "layout", layout)
    directories.set(alias, next)
    vi.resetModules()
    const { selectPanels } = await import("../panel/workspace")
    await expect(selectPanels({ directory: alias, sessionID: "old-owner" })).rejects.toMatchObject({ code: "MRK-7015" })
    expect(await persistent.get(`draft-${encodeDir(alias)}`, "notes.txt")).toBe(draft)
    expect(await persistent.get(`panels-${encodeDir("old-owner")}`, "layout")).toBe(layout)
    const { readDraft } = await import("./draft")
    const { fileOwners } = await import("./references")
    expect(await readDraft(next, "notes.txt")).toBeUndefined()
    expect(await fileOwners(next, "notes.txt")).toEqual([])
    directories.set(alias, original)
    vi.resetModules()
    const restored = await import("../panel/workspace")
    await restored.selectPanels({ directory: alias, sessionID: "old-owner" })
    expect(await (await import("./draft")).readDraft(original, "notes.txt")).toMatchObject({
      content: "original edits",
    })
  },
)

test("a restored non-Git root link recovers legacy drafts and sleeping file owners", async () => {
  vi.resetModules()
  sensitive = true
  unavailable = false
  nonGit = true
  const directory = "/plain-project"
  const alias = "/plain-link"
  directories.set(alias, directory)
  const { persistent } = await import("../../lib/persistence")
  const { encodeDir } = await import("../../lib/route")
  const { selectPanels } = await import("../panel/workspace")
  const { readDraft } = await import("./draft")
  const { fileOwners } = await import("./references")
  await persistent.set(
    `draft-${encodeDir(alias)}`,
    "notes.txt",
    JSON.stringify({ version: 1, content: "legacy non-Git edits", saved: "original" }),
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
  const panels = await selectPanels({ directory: alias, sessionID: "active" })
  const selected = panels.state.tabs.find((tab) => tab.id === panels.state.selected)!
  expect(selected).toMatchObject({ id: "legacy-file", path: "notes.txt", fileDirectory: directory })
  expect
    .soft(await readDraft(selected.fileDirectory!, selected.path!))
    .toMatchObject({ content: "legacy non-Git edits" })
  expect.soft((await fileOwners(directory, "notes.txt")).sort()).toEqual(["active", "sleeping"])
  expect(await readDraft("/other-plain-project", "notes.txt")).toBeUndefined()
  expect(await fileOwners("/other-plain-project", "notes.txt")).toEqual([])
})

test("a legacy self-mapping requires an explicit recovery choice after its link reconnects", async () => {
  vi.resetModules()
  sensitive = true
  unavailable = false
  nonGit = true
  const alias = "/old-missing-link"
  const directory = "/reconnected-project"
  const { persistent } = await import("../../lib/persistence")
  const { encodeDir } = await import("../../lib/route")
  const draft = JSON.stringify({ version: 1, content: "recover old edits", saved: "original", identity: null })
  const refs = '["old-owner","sleeping-owner"]'
  await persistent.set("file-directories", alias, JSON.stringify(alias))
  await persistent.set(`draft-${encodeDir(alias)}`, "notes.txt", draft)
  await persistent.set(`file-links-${encodeDir(alias)}`, "notes.txt", refs)
  directories.set(alias, directory)
  const { readDraft } = await import("./draft")
  await expect(readDraft(directory, "notes.txt")).rejects.toMatchObject({
    code: "MRK-7015",
    data: { directory: alias, actual: directory, previous: alias, recoverable: true },
  })
  expect(await persistent.get(`draft-${encodeDir(alias)}`, "notes.txt")).toBe(draft)
  expect(await persistent.get(`file-links-${encodeDir(alias)}`, "notes.txt")).toBe(refs)
  const { directoryRecovery, recoverDirectory } = await import("./identity")
  const error = await readDraft(directory, "notes.txt").catch((error: unknown) => error)
  const choice = directoryRecovery(error)!
  expect(choice).toBeDefined()
  directories.set(alias, "/changed-again")
  await expect(recoverDirectory(choice)).rejects.toMatchObject({ code: "MRK-7015" })
  expect(await persistent.get(`draft-${encodeDir(alias)}`, "notes.txt")).toBe(draft)
  directories.set(alias, directory)
  await recoverDirectory(choice)
  for (let reload = 0; reload < 2; reload++) {
    vi.resetModules()
    const { readDraft } = await import("./draft")
    const { fileOwners, retainFile } = await import("./references")
    expect(await readDraft(directory, "notes.txt")).toMatchObject({ content: "recover old edits" })
    expect(await fileOwners(directory, "notes.txt")).toEqual(["old-owner", "sleeping-owner"])
    expect(await retainFile(directory, "notes.txt", "old-owner")).toEqual(["old-owner", "sleeping-owner"])
    expect(await persistent.entries(`draft-${encodeDir(alias)}`)).toEqual([])
    expect(await persistent.entries(`file-links-${encodeDir(alias)}`)).toEqual([])
  }
})

test.each(["draft-", "file-links-"])(
  "non-Git recovery preserves %s records through a failed canonical write and repeated reloads",
  async (prefix) => {
    vi.resetModules()
    sensitive = true
    unavailable = false
    nonGit = true
    const directory = "/plain-retry"
    const alias = "/plain-retry-link"
    directories.set(alias, directory)
    const { persistent } = await import("../../lib/persistence")
    const { encodeDir } = await import("../../lib/route")
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
      const { readDraft } = await import("./draft")
      const { retainFile } = await import("./references")
      await expect(
        prefix === "draft-" ? readDraft(directory, "notes.txt") : retainFile(directory, "notes.txt", "active"),
      ).rejects.toMatchObject({ code: "MRK-4018", cause: { message: "storage unavailable" } })
      expect(await persistent.get(`draft-${encodeDir(directory)}`, "notes.txt")).toBe(primary)
      expect(await persistent.get(`draft-${encodeDir(alias)}`, "notes.txt")).toBe(legacy)
      expect(await persistent.get(`file-links-${encodeDir(directory)}`, "notes.txt")).toBe('["active"]')
      expect(await persistent.get(`file-links-${encodeDir(alias)}`, "notes.txt")).toBe('["sleeping"]')
    } finally {
      failure.mockRestore()
    }
    for (let reload = 0; reload < 2; reload++) {
      vi.resetModules()
      const { readDraft } = await import("./draft")
      const { fileOwners, retainFile } = await import("./references")
      expect(await readDraft(directory, "notes.txt")).toMatchObject({
        content: "canonical edits",
        alternatives: [{ content: "legacy edits" }],
      })
      expect(await fileOwners(directory, "notes.txt")).toEqual(["active", "sleeping"])
      expect(await retainFile(directory, "notes.txt", "active")).toEqual(["active", "sleeping"])
      expect(await persistent.entries(`draft-${encodeDir(alias)}`)).toEqual([])
      expect(await persistent.entries(`file-links-${encodeDir(alias)}`)).toEqual([])
      expect(await readDraft("/separate-plain-retry", "notes.txt")).toBeUndefined()
      expect(await fileOwners("/separate-plain-retry", "notes.txt")).toEqual([])
    }
  },
)

test("a retired non-Git source retries its legacy transfer without duplicating file tabs", async () => {
  vi.resetModules()
  sensitive = true
  unavailable = false
  nonGit = true
  const directory = "/plain-transfer"
  const alias = "/plain-transfer-link"
  directories.set(alias, directory)
  const source = `new:${alias}`
  const target = { directory: alias, sessionID: "transfer-target" }
  const { persistent } = await import("../../lib/persistence")
  const { encodeDir } = await import("../../lib/route")
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
    const { selectPanels } = await import("../panel/workspace")
    await expect(selectPanels(target)).rejects.toMatchObject({
      code: "MRK-4018",
      cause: { message: "journal cleanup unavailable" },
    })
    expect(JSON.parse((await persistent.get(`panels-${encodeDir(source)}`, "layout"))!).tabs).toEqual([])
    expect(await persistent.get("panel-transfers", target.sessionID)).toBeTruthy()
  } finally {
    failure.mockRestore()
  }
  for (let restart = 0; restart < 2; restart++) {
    vi.resetModules()
    const { selectPanels } = await import("../panel/workspace")
    const { readDraft } = await import("./draft")
    const { fileOwners } = await import("./references")
    const restored = await selectPanels(target)
    expect(restored.state.tabs).toMatchObject([{ id: "target-file", fileDirectory: directory, path: "notes.txt" }])
    expect(restored.state.selected).toBe("target-file")
    expect(await readDraft(directory, "notes.txt")).toMatchObject({ content: "transfer draft" })
    expect((await fileOwners(directory, "notes.txt")).sort()).toEqual(["sleeping", target.sessionID])
    expect(await persistent.entries("panel-transfers")).toEqual([])
  }
})

test("sleeping sibling aliases recover draft protection, contents and owners before branch switching", async () => {
  vi.resetModules()
  sensitive = true
  unavailable = false
  const directory = "/checkout"
  const alias = "/sibling-link"
  directories.set(alias, directory)
  const { persistent } = await import("../../lib/persistence")
  const { encodeDir } = await import("../../lib/route")
  const { refreshBranches, unsavedReason } = await import("../../state/git")
  const { readDraft, writeDraft } = await import("./draft")
  const { fileOwners } = await import("./references")
  await persistent.set(
    `draft-${encodeDir(alias)}`,
    "notes.txt",
    JSON.stringify({ version: 1, content: "keep me", saved: "original" }),
  )
  await persistent.set(`file-links-${encodeDir(alias)}`, "notes.txt", JSON.stringify(["sleeping"]))
  await refreshBranches(directory)
  expect(unsavedReason(directory)).toBeTruthy()
  expect(await readDraft(directory, "notes.txt")).toMatchObject({ content: "keep me" })
  expect(await fileOwners(directory, "notes.txt")).toEqual(["sleeping"])
  await refreshBranches("/independent-checkout")
  expect(unsavedReason("/independent-checkout")).toBeUndefined()
  await writeDraft(directory, "notes.txt")
  await refreshBranches(directory)
  expect(unsavedReason(directory)).toBeUndefined()
  expect(await persistent.entries(`draft-${encodeDir(alias)}`)).toEqual([])
})

test("a case-only rename reuses the live file key and its draft", async () => {
  vi.resetModules()
  sensitive = false
  unavailable = false
  const directory = "/renamed-file"
  const { selectPanels, openPanel } = await import("../panel/workspace")
  const { writeDraft, readDraft } = await import("./draft")
  const panels = await selectPanels({ directory, sessionID: "renamed" })
  await openPanel({ kind: "file", path: "Notes.txt" })
  const id = panels.state.selected
  await writeDraft(directory, "Notes.txt", { content: "unfinished", saved: "original" })
  spelling = "notes.txt"
  await openPanel({ kind: "file", path: "notes.txt" })
  expect(panels.state.tabs).toHaveLength(1)
  expect(panels.state.selected).toBe(id)
  expect(await readDraft(directory, "notes.txt")).toMatchObject({ content: "unfinished" })
  vi.resetModules()
  const restored = await import("../panel/workspace")
  const next = await restored.selectPanels({ directory, sessionID: "renamed" })
  expect(next.state.tabs[0]?.path).toBe("notes.txt")
  const drafts = await import("./draft")
  expect(await drafts.readDraft(directory, "notes.txt")).toMatchObject({ content: "unfinished" })
})

test("distinct Unicode filenames remain distinct when the SDK confirms both", async () => {
  vi.resetModules()
  sensitive = true
  unavailable = false
  const { selectPanels, openPanel } = await import("../panel/workspace")
  const panels = await selectPanels({ directory: "/unicode-files", sessionID: "unicode" })
  await openPanel({ kind: "file", path: "caf\u00e9.txt" })
  await openPanel({ kind: "file", path: "cafe\u0301.txt" })
  expect(panels.state.tabs.map((tab) => tab.path)).toEqual(["caf\u00e9.txt", "cafe\u0301.txt"])
})

test("an absolute path in a different case-sensitive root reaches the SDK unchanged", async () => {
  vi.resetModules()
  vi.spyOn(navigator, "platform", "get").mockReturnValue("MacIntel")
  sensitive = true
  unavailable = false
  const { selectPanels, openPanel } = await import("../panel/workspace")
  const panels = await selectPanels({ directory: "/Projects/Repo", sessionID: "absolute-root" })
  await openPanel({ kind: "file", path: "/Projects/repo/notes.txt" })
  expect(panels.state.tabs[0]?.path).toBe("/Projects/repo/notes.txt")
})

test("failed identity resolution preserves legacy data and retries without duplicating drafts", async () => {
  vi.resetModules()
  sensitive = false
  unavailable = true
  const directory = "/identity-retry"
  const { persistent } = await import("../../lib/persistence")
  const { encodeDir } = await import("../../lib/route")
  const { selectPanels } = await import("../panel/workspace")
  const { readDraft } = await import("./draft")
  const bucket = `panels-${encodeDir("retry-chat")}`
  const raw = JSON.stringify({ version: 1, tabs: [{ id: "file", kind: "file", path: "notes.txt" }] })
  const draft = JSON.stringify({ version: 1, content: "keep me", saved: "original" })
  await persistent.set(bucket, "layout", raw)
  await persistent.set(`draft-${encodeDir(directory)}`, "notes.txt", draft)
  await expect(selectPanels({ directory, sessionID: "retry-chat" })).rejects.toThrow()
  expect(await persistent.get(bucket, "layout")).toBe(raw)
  expect(await persistent.get(`draft-${encodeDir(directory)}`, "notes.txt")).toBe(draft)
  unavailable = false
  expect((await selectPanels({ directory, sessionID: "retry-chat" })).state.tabs[0]?.path).toBe("Notes.txt")
  expect(await readDraft(directory, "Notes.txt")).toMatchObject({ content: "keep me" })
  vi.resetModules()
  const restored = await import("../panel/workspace")
  await restored.selectPanels({ directory, sessionID: "retry-chat" })
  const drafts = await import("./draft")
  expect(await drafts.readDraft(directory, "Notes.txt")).toMatchObject({ content: "keep me" })
  expect(await persistent.entries(`draft-${encodeDir(directory)}`)).toHaveLength(1)
})

test("case-sensitive worktrees with similar directory names keep separate tabs and owners", async () => {
  vi.resetModules()
  vi.spyOn(navigator, "platform", "get").mockReturnValue("MacIntel")
  sensitive = true
  unavailable = false
  const { selectPanels, openPanel } = await import("../panel/workspace")
  const { fileOwners } = await import("./references")
  const panels = await selectPanels({ directory: "/Projects/Repo", sessionID: "roots" })
  await openPanel({ kind: "file", path: "notes.txt", fileDirectory: "/Projects/Repo" })
  await openPanel({ kind: "file", path: "notes.txt", fileDirectory: "/Projects/repo" })
  expect(panels.state.tabs).toHaveLength(2)
  expect(panels.state.tabs.map((tab) => tab.fileDirectory)).toEqual(["/Projects/Repo", "/Projects/repo"])
  expect(await fileOwners("/Projects/Repo", "notes.txt")).toEqual(["roots"])
  expect(await fileOwners("/Projects/repo", "notes.txt")).toEqual(["roots"])
})

test.each([
  ["Win32", "//server/share/project", false],
  ["MacIntel", "/Users/test/project", false],
  ["MacIntel", "/Users/test/sensitive", true],
] as const)(
  "restored file identities retain drafts and owners on %s in %s",
  async (platform, directory, caseSensitive) => {
    vi.resetModules()
    vi.spyOn(navigator, "platform", "get").mockReturnValue(platform)
    sensitive = caseSensitive
    unavailable = false
    const { persistent } = await import("../../lib/persistence")
    const { encodeDir } = await import("../../lib/route")
    const { selectPanels, openPanel } = await import("../panel/workspace")
    const { readDraft } = await import("./draft")
    const { fileOwners } = await import("./references")
    for (const [path, content, owner] of [
      ["Notes.txt", "Upper draft", "chat-a"],
      ["notes.txt", "Lower draft", "chat-b"],
    ]) {
      await persistent.set(
        `draft-${encodeDir(directory)}`,
        path!,
        JSON.stringify({ version: 1, content, saved: "original" }),
      )
      await persistent.set(`file-links-${encodeDir(directory)}`, path!, JSON.stringify([owner]))
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
    const panels = await selectPanels({ directory, sessionID: "chat-b" })
    expect(panels.state.tabs).toHaveLength(caseSensitive ? 2 : 1)
    expect(panels.state.selected).toBe("lower")
    const selected = panels.state.tabs.find((tab) => tab.id === "lower")!
    const draft = await readDraft(directory, selected.path!)
    if (caseSensitive) {
      expect(draft?.content).toBe("Lower draft")
      expect(await fileOwners(directory, selected.path!)).toEqual(["chat-b"])
    } else {
      expect(selected.path).toBe("Notes.txt")
      expect(draft?.content).toBe("Upper draft")
      expect(draft?.alternatives?.map((value) => value.content)).toEqual(["Lower draft"])
      expect((await fileOwners(directory, selected.path!)).sort()).toEqual(["chat-a", "chat-b"])
      await openPanel({ kind: "file", path: "notes.txt" })
      expect(panels.state.selected).toBe("lower")
    }
  },
)

test.each(["draft", "reference"])("an offline legacy %s leaves a distinct healthy checkout usable", async (kind) => {
  vi.resetModules()
  sensitive = true
  unavailable = false
  const old = "/offline-audit/legacy-nongit"
  const healthy = "/offline-audit/healthy-worktree"
  const { persistent } = await import("../../lib/persistence")
  const { encodeDir } = await import("../../lib/route")
  const { refreshBranches, gitState } = await import("../../state/git")
  const { readDraft } = await import("./draft")
  const { fileOwners } = await import("./references")
  const bucket = (kind === "draft" ? "draft-" : "file-links-") + encodeDir(old)
  const raw =
    kind === "draft"
      ? JSON.stringify({ version: 1, content: "Legacy unsaved text", saved: "Original text", identity: null })
      : JSON.stringify(["offline-owner"])
  await persistent.set(bucket, "notes.txt", raw)
  offline.add(old)
  const refresh = await refreshBranches(healthy)
  expect.soft(refresh, "Healthy checkout branch options should load").toBeDefined()
  expect.soft(gitState(healthy)?.error, "Healthy checkout should have no unrelated recovery error").toBeUndefined()
  const draft = await readDraft(healthy, "notes.txt").catch((error: unknown) => error)
  expect.soft(draft, "Healthy checkout should not inherit another draft or its error").toBeUndefined()
  const owners = await fileOwners(healthy, "notes.txt").catch((error: unknown) => error)
  expect.soft(owners, "Healthy checkout should not inherit another file reference or its error").toEqual([])
  expect(await persistent.get(bucket, "notes.txt")).toBe(raw)
  offline.clear()
  expect(await refreshBranches(healthy)).toBeDefined()
  expect(await readDraft(healthy, "notes.txt")).toBeUndefined()
  expect(await fileOwners(healthy, "notes.txt")).toEqual([])
  expect(await persistent.get(bucket, "notes.txt")).toBe(raw)
})
