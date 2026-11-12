import { expect, test } from "vitest"
import type { AgentAgent, WorkerProductInfo } from "@merakcode/sdk"
import { addedAgent, envPayload, envProblem, envRows, productDraft, productsFor } from "./draft"

const claude: WorkerProductInfo = {
  kind: "claude-code",
  name: "Claude Code",
  available: true,
  binary: "/bin/claude",
  version: "2.1.0",
  caps: { steer: true, permission: true, mcp: true },
}
const worker = (extra: Partial<AgentAgent> = {}): AgentAgent => ({
  id: "a1",
  name: "Worker",
  role: "worker",
  summary: "",
  duties: "",
  toolPool: "worker.default",
  model: { provider: "", model: "" },
  ...extra,
})

test("a detected product becomes a worker that runs it", () => {
  expect(productDraft(claude)).toMatchObject({
    id: "",
    name: "Claude Code",
    role: "worker",
    toolPool: "worker.default",
    product: { kind: "claude-code", binary: "/bin/claude" },
  })
})

test("a product counts as added when an agent of this machine runs its kind", () => {
  expect(addedAgent([worker()], claude)).toBeUndefined()
  const mine = worker({ id: "mine", product: { kind: "claude-code", binary: "/bin/claude" } })
  expect(addedAgent([worker(), mine], claude)?.id).toBe("mine")
  expect(addedAgent([worker({ product: { kind: "codex", binary: "codex" } })], claude)).toBeUndefined()
})

test("only products that can lead are offered for a Leader", () => {
  const products: WorkerProductInfo[] = [
    claude,
    { ...claude, kind: "opencode", name: "OpenCode", caps: { steer: false, permission: true, mcp: true } },
    { ...claude, kind: "pi", name: "Pi" },
    { ...claude, kind: "codex", name: "Codex", available: false },
  ]
  expect(productsFor("leader", products).map((item) => item.kind)).toEqual(["claude-code", "pi"])
  expect(productsFor("worker", products).map((item) => item.kind)).toEqual(["claude-code", "opencode", "pi"])
})

test("environment rows keep a saved secret without showing it and drop rows that were never filled", () => {
  const rows = envRows({ KEY: "", PLAIN: "x" })
  expect(rows).toEqual([
    { name: "KEY", value: "", saved: true },
    { name: "PLAIN", value: "x", saved: false },
  ])
  expect(
    envPayload([...rows, { name: "EMPTY", value: "", saved: false }, { name: "NEW", value: "v", saved: false }]),
  ).toEqual({
    KEY: "",
    PLAIN: "x",
    NEW: "v",
  })
})

test("a row name must be a valid variable name used once", () => {
  expect(envProblem([{ name: "A", value: "1", saved: false }])).toBeUndefined()
  expect(envProblem([{ name: "1A", value: "1", saved: false }])).toBe("invalid")
  expect(
    envProblem([
      { name: "A", value: "1", saved: false },
      { name: "A", value: "2", saved: false },
    ]),
  ).toBe("duplicate")
  expect(envProblem([{ name: "", value: "", saved: false }])).toBeUndefined()
})
