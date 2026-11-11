import { afterEach, beforeEach, expect, test, vi } from "vitest"
import { createRoot } from "solid-js"

beforeEach(() => vi.resetModules())

afterEach(() => {
  vi.restoreAllMocks()
  localStorage.clear()
})

test("a damaged sleeping review layout keeps branch protection and reports a recovery code", async () => {
  const { persistent } = await import("../../lib/persistence")
  const { encodeDir } = await import("../../lib/route")
  const { client } = await import("../../state/client")
  const { refreshBranches, gitState, switchReason } = await import("../../state/git")
  const { summary } = await import("../../state/error")
  const directory = "/damaged-review"
  vi.spyOn(client(directory).vcs, "branchOptions").mockResolvedValue({
    data: { directory, branches: [], current: { branch: "main", head: "head", checkout: "token" } },
  } as never)
  const bucket = `panels-${encodeDir("damaged-owner")}`
  await persistent.set(bucket, "layout", "{broken")
  expect(await refreshBranches(directory)).toBeUndefined()
  expect(switchReason(directory)).toBeTruthy()
  expect(summary(gitState(directory)?.error)).toBe("MRK-4019")
  expect(await persistent.get(bucket, "layout")).toBe("{broken")
})

test("a branch change in a case-sensitive sibling leaves the other worktree's draft and branch unchanged", async () => {
  vi.spyOn(navigator, "platform", "get").mockReturnValue("MacIntel")
  const { draftSnapshot, restoreDraftSnapshot } = await import("./compose")
  const { useReview, setReview, review, addComment, commentDirectory, commentsOf, remainingComments } =
    await import("./state")
  const { updateCheckout } = await import("../../state/git")
  const { state, setState } = await import("../../state/store")
  const { client } = await import("../../state/client")
  const directory = "/Projects/Repo"
  const sibling = "/Projects/repo"
  vi.spyOn(client(sibling).vcs, "get").mockResolvedValue({ data: { branch: "feature", head: "other-head" } } as never)
  restoreDraftSnapshot({
    pending: {
      target: {
        key: "pending",
        directory,
        sessionID: "owner",
        scope: "session",
        file: "notes.txt",
        version: "v1",
        side: "new",
        rows: [],
      },
      text: "Keep feedback",
    },
  })
  setState("branch", directory, "main")
  setState("head", directory, "original-head")
  const dispose = createRoot((dispose) => {
    useReview(
      () => "owner",
      () => directory,
      () => false,
    )
    return dispose
  })
  try {
    const target = draftSnapshot().pending!.target
    commentDirectory("owner", directory)
    addComment("owner", target, "Ready to send")
    addComment("owner", { ...target, directory: sibling }, "Other worktree feedback")
    setReview({ directory, commenting: target, selecting: target })
    updateCheckout(sibling, { branch: "feature", head: "other-head", checkout: "other-token" }, true)
    expect(draftSnapshot().pending?.stale).not.toBe(true)
    expect(state.branch[directory]).toBe("main")
    expect(state.head[directory]).toBe("original-head")
    expect(review.commenting).toEqual(target)
    expect(review.selecting).toEqual(target)
    expect(commentsOf("owner", directory).map((comment) => [comment.text, !!comment.stale])).toEqual([
      ["Ready to send", false],
    ])
    expect(remainingComments(commentsOf("owner"), undefined, directory).map((comment) => comment.text)).toEqual([
      "Other worktree feedback",
    ])
  } finally {
    dispose()
  }
})

test.each([
  ["/sibling-link", "/checkout", "/checkout", true],
  ["/Projects/repo", "/Projects/Repo", "/Projects/repo", false],
] as const)(
  "sleeping review protection resolves %s before comparing it with %s",
  async (source, target, actual, blocked) => {
    vi.spyOn(navigator, "platform", "get").mockReturnValue("MacIntel")
    const { persistent } = await import("../../lib/persistence")
    const { encodeDir } = await import("../../lib/route")
    const { refreshBranches, unsavedReason } = await import("../../state/git")
    const { client } = await import("../../state/client")
    for (const [directory, canonical] of [
      [source, actual],
      [target, target],
    ])
      vi.spyOn(client(directory!).vcs, "branchOptions").mockResolvedValue({
        data: { directory: canonical, branches: [], current: null },
      } as never)
    await persistent.set(
      `panels-${encodeDir("sleeping")}`,
      "layout",
      JSON.stringify({
        version: 1,
        directory: source,
        tabs: [{ id: "review", kind: "review", view: { drafts: { pending: { text: "Keep feedback" } } } }],
      }),
    )
    await refreshBranches(target)
    expect(!!unsavedReason(target)).toBe(blocked)
  },
)

test("legacy review comments in a project subdirectory protect the checkout before their conversation is opened", async () => {
  const { persistent } = await import("../../lib/persistence")
  const { encodeDir } = await import("../../lib/route")
  const { refreshBranches, unsavedReason } = await import("../../state/git")
  const { client } = await import("../../state/client")
  for (const directory of ["/legacy-review", "/legacy-review/sub"])
    vi.spyOn(client(directory).vcs, "branchOptions").mockResolvedValue({
      data: { directory: "/legacy-review", branches: [], current: null },
    } as never)
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
                  directory: "/legacy-review/sub",
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
  await refreshBranches("/legacy-review")
  expect(unsavedReason("/legacy-review")).toBeTruthy()
})

test("a failed final review write keeps branch protection until the clear is durable", async () => {
  const { selectPanels, openPanel } = await import("../panel/workspace")
  const { persistent } = await import("../../lib/persistence")
  const { unsavedReason } = await import("../../state/git")
  const directory = "/review-clear-failure"
  const owner = await selectPanels({ directory, sessionID: "owner" })
  await openPanel({ kind: "review", view: { drafts: { pending: { text: "Unsaved feedback" } } } })
  await owner.flush()
  const fail = vi.spyOn(persistent, "set").mockRejectedValueOnce(new Error("Clear unavailable"))
  await expect(owner.remove(owner.state.tabs[0]!.id)).rejects.toThrow("Clear unavailable")
  expect(unsavedReason(directory)).toBeTruthy()
  fail.mockRestore()
  await owner.flush()
  expect(unsavedReason(directory)).toBeUndefined()
})

test("a sleeping review draft blocks its worktree after reload until the last draft is discarded", async () => {
  const directory = "/review-guard"
  const before = await import("../panel/workspace")
  const owner = await before.selectPanels({ directory, sessionID: "owner" })
  await before.openPanel({
    kind: "review",
    view: {
      drafts: {
        pending: {
          target: {
            key: "pending",
            directory,
            sessionID: "owner",
            scope: "session",
            file: "notes.txt",
            version: "v1",
            side: "new",
            rows: [],
          },
          text: "Keep this feedback",
        },
      },
    },
  })
  await owner.flush()
  vi.resetModules()
  const after = await import("../panel/workspace")
  const git = await import("../../state/git")
  const { client } = await import("../../state/client")
  for (const location of [directory, "/independent-tree"])
    vi.spyOn(client(location).vcs, "branchOptions").mockResolvedValue({
      data: { directory: location, branches: [], current: { branch: "main", head: "head", checkout: "token" } },
    } as never)
  await after.selectPanels({ directory, sessionID: "other" })
  await git.refreshBranches(directory)
  expect(git.switchReason(directory)).toBeTruthy()
  await git.refreshBranches("/independent-tree")
  expect(git.switchReason("/independent-tree")).toBeUndefined()
  const restored = await after.selectPanels({ directory, sessionID: "owner" })
  expect(restored.state.tabs[0]?.view?.drafts).toMatchObject({ pending: { text: "Keep this feedback" } })
  await restored.remove(restored.state.tabs[0]!.id)
  await git.refreshBranches(directory)
  expect(git.switchReason(directory)).toBeUndefined()
})
