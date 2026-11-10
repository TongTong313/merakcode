import { expect, test } from "vitest"
import type { EngineEvent } from "../protocol.gen"
import { foldGroupUsage } from "../index"

test("folds usage once per event and preserves separate currencies and unknown costs", () => {
  const fact = (id: string, currency: string, costKnown: boolean): EngineEvent => ({
    id,
    stream: `session:${id}`,
    seq: 1,
    scope: { group: "g", task: "t" },
    time: "2026-11-10T00:00:00Z",
    type: "turn.finished",
    actor: { kind: "agent", id: "m" },
    payload: {
      stop: "answered",
      usage: { input: 100, output: 20, cacheRead: 10, cacheWrite: 5, cost: 2, currency, costKnown },
    },
  })
  const first = fact("one", "USD", true)
  expect(foldGroupUsage([first, first, fact("two", "CNY", true), fact("three", "", false)])).toEqual({
    budgets: [],
    currencies: ["CNY", "USD"],
    rows: [
      {
        task: "t",
        member: "m",
        input: 300,
        output: 60,
        cacheRead: 30,
        cacheWrite: 15,
        costs: { USD: 2, CNY: 2 },
        unknown: true,
      },
    ],
  })
})

test("keeps the newest context budget when historical events arrive late", () => {
  const budget = (seq: number): EngineEvent => ({
    id: `budget-${seq}`,
    stream: "session:s",
    seq,
    scope: { session: "s" },
    time: "2026-11-10T00:00:00Z",
    type: "session.budget",
    actor: { kind: "agent" },
    payload: {
      system: 10,
      tools: 20,
      messages: 30,
      reserve: 40,
      total: 100,
      window: 200,
      cacheRead: 0,
      cacheWrite: 0,
      purpose: "reply",
    },
  })
  expect(foldGroupUsage([budget(8), budget(3)]).budgets).toEqual([budget(8)])
})
