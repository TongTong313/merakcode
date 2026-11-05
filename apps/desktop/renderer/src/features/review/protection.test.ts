import { afterEach, beforeEach, expect, test, vi } from "vitest"

beforeEach(() => vi.resetModules())

afterEach(() => {
  vi.restoreAllMocks()
  localStorage.clear()
})

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
