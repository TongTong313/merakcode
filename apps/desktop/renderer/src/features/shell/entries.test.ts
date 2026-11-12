import { expect, test } from "vitest"
import type { GroupGroup, TaskCard } from "@merakcode/sdk"
import { entriesOf } from "./entries"

const group = (id: string, directory: string, name = id): GroupGroup => ({
  id,
  kind: "local",
  name,
  leader: "leader",
  project: { directory },
})
const card = (id: string, project: string, extra: Partial<TaskCard> = {}): TaskCard => ({
  id,
  project,
  title: id,
  description: "",
  acceptance: null,
  claims: null,
  createdBy: { kind: "human", id: "me" },
  priority: 0,
  status: "open",
  ...extra,
})

test("a workspace lists its groups, tasks and conversations by latest update, newest first", () => {
  const entries = entriesOf("/work/app", {
    groups: [group("g-old", "/work/app"), group("g-new", "/work/app"), group("g-elsewhere", "/work/docs")],
    tasks: [
      card("t-mid", "/work/app"),
      card("t-elsewhere", "/work/docs"),
      card("t-archived", "/work/app", { archived: true }),
    ],
    sessions: [
      { id: "s-newest", title: "Newest", directory: "/work/app", time: { created: 1, updated: 400 } },
      { id: "s-oldest", title: "Oldest", directory: "/work/app", time: { created: 1, updated: 50 } },
    ],
    updated: (_kind, id) => ({ "g-old": 100, "g-new": 300, "t-mid": 200 })[id] ?? 0,
  })
  expect(entries.map((entry) => `${entry.kind}:${entry.id}`)).toEqual([
    "session:s-newest",
    "group:g-new",
    "task:t-mid",
    "group:g-old",
    "session:s-oldest",
  ])
})

test("spellings of the workspace directory are the same workspace", () => {
  const entries = entriesOf("/work/app", {
    groups: [group("g", "/work/app/")],
    tasks: [],
    sessions: [],
    updated: () => 1,
  })
  expect(entries.map((entry) => entry.id)).toEqual(["g"])
})

test("archived groups are left out", () => {
  const entries = entriesOf("/work/app", {
    groups: [{ ...group("kept", "/work/app") }, { ...group("gone", "/work/app"), archived: true }],
    tasks: [],
    sessions: [],
    updated: () => 1,
  })
  expect(entries.map((entry) => entry.id)).toEqual(["kept"])
})

test("a conversation that runs in a worktree of the workspace is listed with it, not with another workspace", () => {
  const sources = {
    groups: [],
    tasks: [],
    sessions: [
      { id: "s-tree", title: "In a worktree", directory: "/tmp/trees/app-1", time: { created: 1, updated: 10 } },
      { id: "s-main", title: "In the folder", directory: "/work/app", time: { created: 1, updated: 5 } },
    ],
    worktrees: [{ path: "/tmp/trees/app-1", root: "/work/app" }],
    updated: () => 1,
  }
  expect(entriesOf("/work/app", sources).map((entry) => entry.id)).toEqual(["s-tree", "s-main"])
  expect(entriesOf("/work/docs", sources)).toEqual([])
})

test("a workspace opened through a link lists the conversations the engine placed in its real directory", () => {
  const sources = {
    groups: [],
    tasks: [],
    sessions: [{ id: "s", title: "Real", directory: "/real/app", time: { created: 1, updated: 10 } }],
    canonical: (directory: string) => (directory === "/links/app" ? "/real/app" : directory),
    updated: () => 1,
  }
  expect(entriesOf("/links/app", sources).map((entry) => entry.id)).toEqual(["s"])
  expect(entriesOf("/real/app", sources).map((entry) => entry.id)).toEqual(["s"])
  expect(entriesOf("/links/other", sources)).toEqual([])
})
