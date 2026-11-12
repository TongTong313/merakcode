import { createSignal } from "solid-js"
import type { AgentAgent, WorkerProductInfo } from "@merakcode/sdk"
import { client } from "./client"

const [agents, setAgents] = createSignal<AgentAgent[]>([])
const [catalog, setCatalog] = createSignal<WorkerProductInfo[]>([])
const [catalogLoaded, setCatalogLoaded] = createSignal(false)
export { agents, catalog, catalogLoaded }

/** The agents of this person, the built-in ones first. */
export async function loadAgents() {
  const list = (await (await client()).agent.list({})) ?? []
  setAgents(list)
  return list
}

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
