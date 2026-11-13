import { createSignal } from "solid-js"
import type { AgentAgent, WorkerProductInfo } from "@merakcode/sdk"
import { client } from "./client"

const [agents, setAgents] = createSignal<AgentAgent[]>([])
const [catalog, setCatalog] = createSignal<WorkerProductInfo[]>([])
const [catalogLoaded, setCatalogLoaded] = createSignal(false)
const [agentsLoaded, setAgentsLoaded] = createSignal(false)
export { agents, agentsLoaded, catalog, catalogLoaded }

/** The agents of this person, the built-in ones first. */
export async function loadAgents() {
  const list = (await (await client()).agent.list({})) ?? []
  // An unchanged list keeps its objects, so what shows it is not rebuilt
  if (JSON.stringify(list) !== JSON.stringify(agents())) setAgents(list)
  setAgentsLoaded(true)
  return list
}

/** The agents a new conversation can be held with: they run an external product and are turned on. */
export const chatTargets = (list: readonly AgentAgent[]) =>
  list.filter(
    (agent) => agent.product && agent.product.kind !== "builtin" && agent.product.kind !== "remote" && !agent.disabled,
  )

/** Looks for the AI coding products installed on this machine; it takes a few seconds. */
export async function loadCatalog() {
  const found = (await (await client()).agent.catalog()) ?? []
  setCatalog(found)
  setCatalogLoaded(true)
  return found
}

export async function saveAgent(agent: AgentAgent) {
  const saved = await (await client()).agent.save({ agent })
  await loadAgents()
  return saved
}

export async function deleteAgent(id: string) {
  await (await client()).agent.delete({ agent: id })
  await loadAgents()
}
