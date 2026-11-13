import type { AgentAgent, WorkerProductInfo } from "@merakcode/sdk"

export type EnvRow = { name: string; value: string; saved: boolean }

/** An agent that runs a product found on this machine, ready to be saved as it is. */
export function productDraft(product: WorkerProductInfo): AgentAgent {
  return {
    id: "",
    name: product.name,
    summary: `Runs ${product.name}.`,
    duties: "",
    toolPool: "worker.default",
    shared: true,
    model: { provider: "", model: "" },
    product: { kind: product.kind, binary: product.binary ?? "" },
  }
}

/** The agent of this machine that already runs a product, if any. */
export function addedAgent(agents: readonly AgentAgent[], product: WorkerProductInfo) {
  return agents.find((agent) => agent.product?.kind === product.kind)
}

/** The products an agent can run: the ones found on this machine. */
export function productsFor(products: readonly WorkerProductInfo[]) {
  return products.filter((product) => product.kind !== "builtin" && product.available)
}

/** The products that take messages in the middle of a turn and speak MCP, so an agent that runs one can lead. */
const LEADING_PRODUCTS = ["claude-code", "codex", "pi"]

/** No agent is a Leader by nature; a group gives the seat. This says whether the engine will accept one for it. */
export function canLead(agent: AgentAgent) {
  return !agent.product || agent.product.kind === "builtin" || LEADING_PRODUCTS.includes(agent.product.kind)
}

/** The saved secrets of an agent come back with empty values: the row says it is saved and shows nothing. */
export function envRows(env?: Record<string, string>): EnvRow[] {
  return Object.entries(env ?? {}).map(([name, value]) => ({ name, value, saved: value === "" }))
}

/** A row that is neither saved nor filled is dropped; an empty value of a saved row keeps the stored secret. */
export function envPayload(rows: readonly EnvRow[]) {
  return Object.fromEntries(
    rows.filter((row) => row.name.trim() && (row.saved || row.value)).map((row) => [row.name.trim(), row.value]),
  )
}

export function envProblem(rows: readonly EnvRow[]): "invalid" | "duplicate" | undefined {
  const names = rows.map((row) => row.name.trim()).filter(Boolean)
  if (names.some((name) => !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name))) return "invalid"
  if (new Set(names).size !== names.length) return "duplicate"
}
