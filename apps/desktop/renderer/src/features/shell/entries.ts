import type { GroupGroup, TaskCard } from "@merakcode/sdk"
import { sameDir } from "../../lib/route"
import type { SessionSummary } from "../../state/store"

export type Entry =
  | { kind: "group"; id: string; updated: number; group: GroupGroup }
  | { kind: "task"; id: string; updated: number; task: TaskCard }
  | {
      kind: "session"
      id: string
      updated: number
      session: Pick<SessionSummary, "id" | "title" | "directory" | "time">
    }

type Sources = {
  groups: readonly GroupGroup[]
  tasks: readonly TaskCard[]
  sessions: readonly Pick<SessionSummary, "id" | "title" | "directory" | "time">[]
  /** Worktrees of the open folders: a conversation that runs in one is listed with its folder */
  worktrees?: readonly { path: string; root: string }[]
  /** The real directory a spelling of a workspace stands for, once the engine has confirmed it */
  canonical?: (directory: string) => string
  /** When a group or a task last changed, in milliseconds */
  updated: (kind: "group" | "task", id: string) => number
}

/** What the sidebar lists under one workspace: its groups, tasks and conversations, the latest change first. */
export function entriesOf(directory: string, sources: Sources): Entry[] {
  const real = sources.canonical ?? ((value: string) => value)
  const here = (other: string) => sameDir(real(other), real(directory))
  return [
    ...sources.groups
      .filter((group) => !group.archived && here(group.project.directory))
      .map((group): Entry => ({ kind: "group", id: group.id, updated: sources.updated("group", group.id), group })),
    ...sources.tasks
      .filter((task) => !task.archived && here(task.project))
      .map((task): Entry => ({ kind: "task", id: task.id, updated: sources.updated("task", task.id), task })),
    ...sources.sessions
      .filter(
        (session) =>
          here(session.directory) ||
          sources.worktrees?.some((tree) => here(tree.root) && sameDir(tree.path, session.directory)),
      )
      .map((session): Entry => ({ kind: "session", id: session.id, updated: session.time.updated, session })),
  ].toSorted((a, b) => b.updated - a.updated)
}
