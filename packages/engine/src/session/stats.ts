/**
 * Usage statistics (`merak stats`): messages, cost, tokens, and tool and model calls, aggregated over sessions.
 * Covers all sessions stored on this machine, optionally filtered by project or by the last N days.
 */
import z from "zod"
import { Session } from "./index"

const DAY = 24 * 60 * 60 * 1000

const Tokens = z.object({
  input: z.number(),
  output: z.number(),
  cache: z.object({ read: z.number(), write: z.number() }),
})

export namespace SessionStats {
  export const Info = z
    .object({
      totalSessions: z.number(),
      totalMessages: z.number(),
      totalCost: z.number(),
      totalTokens: Tokens.extend({ reasoning: z.number() }),
      toolUsage: z.record(z.string(), z.number()),
      /** Keyed by provider/model; output includes reasoning tokens */
      modelUsage: z.record(z.string(), z.object({ messages: z.number(), tokens: Tokens, cost: z.number() })),
      dateRange: z.object({ earliest: z.number(), latest: z.number() }),
      /** Days in the window: the days query if given (0 means today and counts as 1), else earliest to latest */
      days: z.number(),
      costPerDay: z.number(),
      tokensPerSession: z.number(),
      medianTokensPerSession: z.number(),
    })
    .meta({ ref: "SessionStats" })
  export type Info = z.infer<typeof Info>

  export const Query = z.object({
    days: z.coerce.number().optional().meta({ description: "Only sessions updated in the last N days (0 = today)" }),
    project: z.string().optional().meta({ description: "Only sessions of this project ID" }),
  })

  export async function aggregate(all: Session.Info[], query: z.infer<typeof Query>): Promise<Info> {
    const now = Date.now()
    const cutoff = (() => {
      if (query.days === undefined) return 0
      if (query.days > 0) return now - query.days * DAY
      const today = new Date(now)
      today.setHours(0, 0, 0, 0)
      return today.getTime()
    })()
    const window = query.days === undefined ? undefined : Math.max(1, query.days)
    const sessions = all.filter(
      (session) =>
        session.time.updated >= cutoff && (query.project === undefined || session.projectID === query.project),
    )

    const stats: Info = {
      totalSessions: sessions.length,
      totalMessages: 0,
      totalCost: 0,
      totalTokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      toolUsage: {},
      modelUsage: {},
      dateRange: { earliest: now, latest: now },
      days: window ?? 0,
      costPerDay: 0,
      tokensPerSession: 0,
      medianTokensPerSession: 0,
    }
    if (sessions.length === 0) return stats

    // Load messages 20 sessions at a time so many sessions do not open too many files at once.
    const totals: number[] = []
    const range = { earliest: Infinity, latest: 0 }
    for (let i = 0; i < sessions.length; i += 20) {
      const batch = sessions.slice(i, i + 20)
      const loaded = await Promise.all(
        batch.map((session) => Session.messages({ sessionID: session.id, projectID: session.projectID })),
      )
      loaded.forEach((messages, index) => {
        const session = batch[index]!
        range.earliest = Math.min(range.earliest, cutoff > 0 ? session.time.updated : session.time.created)
        range.latest = Math.max(range.latest, session.time.updated)
        stats.totalMessages += messages.length
        let total = 0
        for (const message of messages) {
          for (const part of message.parts) {
            if (part.type === "tool") stats.toolUsage[part.tool] = (stats.toolUsage[part.tool] ?? 0) + 1
          }
          if (message.info.role !== "assistant") continue
          const { tokens, cost } = message.info
          const key = `${message.info.providerID}/${message.info.modelID}`
          const model = (stats.modelUsage[key] ??= {
            messages: 0,
            tokens: { input: 0, output: 0, cache: { read: 0, write: 0 } },
            cost: 0,
          })
          model.messages++
          model.cost += cost
          model.tokens.input += tokens.input
          model.tokens.output += tokens.output + tokens.reasoning
          model.tokens.cache.read += tokens.cache.read
          model.tokens.cache.write += tokens.cache.write
          stats.totalCost += cost
          stats.totalTokens.input += tokens.input
          stats.totalTokens.output += tokens.output
          stats.totalTokens.reasoning += tokens.reasoning
          stats.totalTokens.cache.read += tokens.cache.read
          stats.totalTokens.cache.write += tokens.cache.write
          total += tokens.input + tokens.output + tokens.reasoning + tokens.cache.read + tokens.cache.write
        }
        totals.push(total)
      })
    }

    const days = window ?? Math.max(1, Math.ceil((range.latest - range.earliest) / DAY))
    const sum = totals.reduce((a, b) => a + b, 0)
    totals.sort((a, b) => a - b)
    const mid = Math.floor(totals.length / 2)
    return {
      ...stats,
      dateRange: range,
      days,
      costPerDay: stats.totalCost / days,
      tokensPerSession: sum / sessions.length,
      medianTokensPerSession: totals.length % 2 === 0 ? (totals[mid - 1]! + totals[mid]!) / 2 : totals[mid]!,
    }
  }
}
