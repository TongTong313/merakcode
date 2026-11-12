import { batch } from "solid-js"
import { createStore, reconcile } from "solid-js/store"
import { EngineEventSchema, type EngineEvent, type TaskCard } from "@merakcode/sdk"
import { log } from "../lib/bridge"
import { client, onConnection } from "./client"
import { listen } from "./store"

type State = {
  cards: Record<string, TaskCard>
  archive: Record<string, TaskCard>
  /** The id of the latest event applied to each task, so an older event never undoes a newer one */
  seen: Record<string, string>
  updated: Record<string, number>
  /** Whether each claim was taken by its worker or given to it, by the actor of the event that queued it */
  origin: Record<string, "self" | "assigned">
  loaded: boolean
}

const [state, setState] = createStore<State>({
  cards: {},
  archive: {},
  seen: {},
  updated: {},
  origin: {},
  loaded: false,
})

const CARD_EVENTS = new Set([
  "task.created",
  "task.bound",
  "task.archived",
  "task.opened",
  "task.queued",
  "task.started",
  "task.reported",
  "task.reviewed",
  "task.updated",
  "task.closed",
  "phase.changed",
])

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"

/** Engine identifiers are ULIDs: the first ten characters are the creation time in milliseconds. */
export function createdAt(id: string) {
  let time = 0
  for (const char of id.slice(0, 10)) time = time * 32 + Math.max(0, CROCKFORD.indexOf(char.toUpperCase()))
  return time
}

/** The tasks on the board: every task of this client that is not archived. */
export const tasks = () => Object.values(state.cards)
export const archivedTasks = () => Object.values(state.archive)
export const tasksLoaded = () => state.loaded
export const claimOrigin = (claim: string) => state.origin[claim]
export const taskUpdated = (id: string) => state.updated[id] ?? createdAt(id)
export const taskOf = (id: string): TaskCard | undefined => state.cards[id] ?? state.archive[id]

function put(card: TaskCard) {
  batch(() => {
    if (card.archived) {
      setState("cards", card.id, undefined!)
      setState("archive", card.id, card)
      return
    }
    setState("archive", card.id, undefined!)
    setState("cards", card.id, reconcile(card))
  })
}

/** Tasks an event changed while a list request was in flight: the answer may be older than the event. */
let changing: Set<string> | undefined

function remember(event: EngineEvent) {
  if (event.type !== "task.queued") return
  for (const claim of event.payload.claims ?? [])
    if (!state.origin[claim.id]) setState("origin", claim.id, event.actor.id === claim.member ? "self" : "assigned")
}

export function receiveTaskEvent(event: EngineEvent) {
  remember(event)
  if (!CARD_EVENTS.has(event.type)) return
  const card = event.payload as TaskCard
  if (!card?.id || (state.seen[card.id] ?? "") >= event.id) return
  changing?.add(card.id)
  batch(() => {
    setState("seen", card.id, event.id)
    setState("updated", card.id, Date.parse(event.time))
    put(card)
  })
}

/** Reads every task, visible and archived, and replaces what was known; the events of a task win over the answer. */
export async function loadTasks() {
  const connection = await client()
  const during = new Set<string>()
  changing = during
  try {
    const [visible, archived, queued] = await Promise.all([
      connection.task.list({}),
      connection.task.list({ archived: true }),
      connection.events.find({ types: ["task.queued"] }),
    ])
    for (const fact of queued ?? []) remember(EngineEventSchema.parse(fact))
    batch(() => {
      for (const card of [...(visible ?? []), ...(archived ?? [])]) if (!during.has(card.id)) put(card)
      setState("loaded", true)
    })
  } finally {
    if (changing === during) changing = undefined
  }
}

/** Follows the task events of every group and of the tasks no group has taken. */
export function connectTasks() {
  const stopListening = listen((_directory, event) => receiveTaskEvent(event))
  const stopConnection = onConnection((connection) => {
    if (!connection) return
    void loadTasks().catch(() => log("error", "task list request failed", { code: "MRK-1003" }))
  })
  return () => {
    stopListening()
    stopConnection()
  }
}
