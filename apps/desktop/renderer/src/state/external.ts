import { createStore, produce } from "solid-js/store"
import type { AgentAgent } from "@merakcode/sdk"
import { storage } from "../lib/bridge"
import { client } from "./client"

/** The agent that drives each conversation the window knows; "" is the engine's own model, a missing id is unknown. */
const [drivers, setDrivers] = createStore<Record<string, string>>({})
/** Conversations whose product was turned off and whose person chose not to hand them over; the agent they asked about. */
const [declined, setDeclined] = createStore<Record<string, string>>({})
/** Conversations MerakCode took over in this window. */
const [taken, setTaken] = createStore<Record<string, boolean>>({})
let restored: Promise<void> | undefined

function restore() {
  restored ??= storage.get<Record<string, string>>("takeover-declined", {}).then((saved) => {
    setDeclined(saved)
  })
  return restored
}

/** The agent of a conversation with an external product, "" for a conversation of the engine's own model. */
export const driverOf = (id: string): string | undefined => drivers[id]
export const wasTakenOver = (id: string) => !!taken[id]

/** Asks the engine who drives a conversation; the answers about taking over are read first, so none is asked twice. */
export async function loadDriver(id: string) {
  const [known] = await Promise.all([(await client()).session.external({ session: id }), restore()])
  setDrivers(id, known.agent ?? "")
}

/** A conversation the window has just started with an agent. */
export function rememberDriver(id: string, agent: string) {
  setDrivers(id, agent)
}

/** An agent that cannot be talked to: gone, or turned off. */
export const unusable = (agent: AgentAgent | undefined) => !agent || !!agent.disabled

/** Whether the person said "not now" to taking over this conversation from this agent. */
export const hasDeclined = (id: string, agent: string) => declined[id] === agent

export async function decline(id: string, agent: string) {
  setDeclined(id, agent)
  await storage.set("takeover-declined", { ...declined })
}

/** The product is usable again: the question may come back the next time it is turned off. */
export async function forgetDecline(id: string) {
  if (declined[id] === undefined) return
  setDeclined(produce((all) => delete all[id]))
  await storage.set("takeover-declined", { ...declined })
}

/** MerakCode takes over a conversation with an external product; the model answers from now on. */
export async function takeOver(id: string, selection?: { provider: string; model: string; thinking?: string }) {
  await (await client()).session.takeover({ session: id, confirm: true, selection })
  setDrivers(id, "")
  setTaken(id, true)
}
