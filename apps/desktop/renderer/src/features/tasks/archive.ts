import type { TaskCard } from "@merakcode/sdk"
import { client } from "../../state/client"

export const isFinished = (card: Pick<TaskCard, "status">) => ["done", "failed", "cancelled"].includes(card.status)

/** Archives finished tasks in one request; a task that has not finished is cancelled first, so the person must agree. */
export async function archiveCards(cards: readonly Pick<TaskCard, "id" | "status">[]) {
  const connection = await client()
  for (const card of cards) if (!isFinished(card)) await connection.task.cancel({ task: card.id })
  await connection.task.archive({ tasks: cards.map((card) => card.id), archived: true })
}

export async function restoreCard(id: string) {
  await (await client()).task.archive({ tasks: [id], archived: false })
}
