import type {
  AgentConnectionProduct,
  AgentConnectionProductChangeData,
  CollaborationRoleTemplate,
} from "@merakcode/sdk/client"
import { createSignal } from "solid-js"
import { call, client } from "./client"
import { listen } from "./store"

const [agentConnections, setAgentConnections] = createSignal<AgentConnectionProduct[]>([])
const [connectionsLoaded, setConnectionsLoaded] = createSignal(false)
const [roleTemplates, setRoleTemplates] = createSignal<CollaborationRoleTemplate[]>([])
export { agentConnections, connectionsLoaded, roleTemplates }
let productRequest: Promise<AgentConnectionProduct[]> | undefined
let templateRequest: Promise<CollaborationRoleTemplate[]> | undefined
let generation = 0
let templateGeneration = 0

function receiveConnections(result: Promise<AgentConnectionProduct[]>) {
  const current = ++generation
  const request = result
    .then((list) => {
      if (current === generation) {
        setAgentConnections(list)
        setConnectionsLoaded(true)
      }
      return list
    })
    .finally(() => {
      if (productRequest === request) productRequest = undefined
    })
  productRequest = request
  return request
}

export function refreshConnections(refresh = false) {
  return receiveConnections(call(client().agentConnection.products(refresh ? { refresh: "true" } : {})))
}

export function changeConnection(body: AgentConnectionProductChangeData["body"]) {
  return receiveConnections(call(client().agentConnection.product.change({ body })))
}

export function loadConnections() {
  return productRequest ?? (connectionsLoaded() ? Promise.resolve(agentConnections()) : refreshConnections())
}

function refreshRoleTemplates() {
  const current = ++templateGeneration
  const request = call(client().collaboration.roleTemplates())
    .then((list) => {
      if (current === templateGeneration) setRoleTemplates(list)
      return list
    })
    .finally(() => {
      if (templateRequest === request) templateRequest = undefined
    })
  templateRequest = request
  return request
}

export function loadRoleTemplates() {
  return templateRequest ?? (roleTemplates().length ? Promise.resolve(roleTemplates()) : refreshRoleTemplates())
}

listen((_directory, event) => {
  if (event.type !== "config.updated") return
  void refreshConnections().catch(() => undefined)
  void refreshRoleTemplates().catch(() => undefined)
})
