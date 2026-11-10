import type { EngineEvent } from "../protocol.gen"

export function foldGroupUsage(events: EngineEvent[]) {
  const latest = new Map<string, Extract<EngineEvent, { type: "session.budget" }>>()
  for (const event of events) {
    if (event.type !== "session.budget" || !event.scope.session) continue
    const previous = latest.get(event.scope.session)
    if (!previous || (event.seq ?? 0) > (previous.seq ?? 0)) latest.set(event.scope.session, event)
  }

  const seen = new Set<string>()
  const currencies = new Set<string>()
  const rows = new Map<
    string,
    {
      task: string
      member: string
      input: number
      output: number
      cacheRead: number
      cacheWrite: number
      costs: Record<string, number>
      unknown: boolean
    }
  >()
  for (const event of events) {
    if (event.type !== "turn.finished" || seen.has(event.id)) continue
    seen.add(event.id)
    const task = event.scope.task ?? ""
    const member = event.actor.id ?? ""
    const key = JSON.stringify([task, member])
    const row = rows.get(key) ?? {
      task,
      member,
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      costs: {} as Record<string, number>,
      unknown: false,
    }
    const usage = event.payload.usage
    row.input += usage.input
    row.output += usage.output
    row.cacheRead += usage.cacheRead
    row.cacheWrite += usage.cacheWrite
    if (usage.costKnown && usage.currency) {
      currencies.add(usage.currency)
      row.costs[usage.currency] = (row.costs[usage.currency] ?? 0) + usage.cost
    } else row.unknown = true
    rows.set(key, row)
  }
  return { budgets: [...latest.values()], rows: [...rows.values()], currencies: [...currencies].sort() }
}
