import type { Board, GroupGroup } from "@merakcode/sdk"
import { sameDir } from "../../lib/route"

/**
 * What it means to give a task to a group: the group moves to the task's workspace when its own is another one, which
 * the engine refuses while the group has a claim that runs or waits.
 */
export function groupChoice(taskProject: string, group: GroupGroup, board: Board) {
  const moves = !sameDir(taskProject, group.project.directory)
  const working = Object.values(board.columns)
    .flat()
    .some((card) => card.claims?.some((claim) => claim.status === "active" || claim.status === "queued"))
  return { moves, busy: moves && working }
}
