import { Instance } from "../project/instance"
import { Todo } from "../session/todo"
import { changedFiles, withOwners } from "./artifacts"
import { groupState, leaderPrompt } from "./prompt"
import { configuredProducts, titleOf } from "./run"
import { load } from "./store"

/**
 * The leader's group context for this step, rebuilt from the record each time; empty outside a group. The roster
 * rarely changes and goes before the history; the state changes as the work goes on and goes after it, so a todo
 * change leaves the cached history intact.
 */
export async function leaderContext(sessionID: string): Promise<{ roster: string[]; state: string[] }> {
  const group = await load(sessionID)
  if (!group) return { roster: [], state: [] }
  const todos = await Todo.get(sessionID)
  const files = await changedFiles(Instance.directory, group.baseline).catch(() => [])
  return {
    roster: [leaderPrompt({ group, title: titleOf(await configuredProducts()) })],
    state: [groupState({ todos, artifacts: withOwners(files, todos) })],
  }
}
