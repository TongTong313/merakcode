import { Bus } from "../../../infra/bus"
import { BusEvent } from "../../../infra/bus/bus-event"
import { Instance } from "../../../infra/project/instance"
import { Storage } from "../../../infra/storage/storage"
import { SessionStore } from "../../../agent/session/store"
import { z } from "zod"
import {
  GroupError,
  addResult,
  addSeat,
  createGroup,
  removeSeat,
  setPrivateSession,
  updateSeat,
  type Group,
  type Result,
  type SeatInput,
} from "./board"

/** A group record changed; the chat reloads it */
export const Updated = BusEvent.define(
  "collaboration.updated",
  z.object({
    sessionID: z.string(),
  }),
)

const key = (sessionID: string) => ["collaboration", sessionID]

async function published(sessionID: string, group: Group) {
  if (Instance.has()) await Bus.publish(Updated, { sessionID }).catch(() => undefined)
  return group
}

/** Applies a change to the stored group in one transaction, so concurrent changes are not lost */
async function mutate(sessionID: string, fn: (group: Group) => Group) {
  if (!(await load(sessionID))) throw new GroupError({ zh: "没有这个群", en: "Group not found" })
  const group = await Storage.update<Group>(key(sessionID), (draft) => {
    Object.assign(draft, fn(draft))
  })
  return published(sessionID, group)
}

export async function load(sessionID: string) {
  return Storage.read<Group>(key(sessionID)).catch(() => undefined)
}

/** Groups of every project with their sessions, most recently active first */
export async function all() {
  const sessions = SessionStore.search({ roots: true }).filter(({ session }) => session.metadata?.group === true)
  const found = await Promise.all(sessions.map(async ({ session }) => ({ session, group: await load(session.id) })))
  return found.flatMap(({ session, group }) => (group ? [{ session, group }] : []))
}

export async function open(sessionID: string) {
  const group = await load(sessionID)
  if (!group) throw new GroupError({ zh: "没有这个群", en: "Group not found" })
  return group
}

export async function create(
  sessionID: string,
  input: { leader: SeatInput; seats?: (SeatInput & { product: string })[] },
  baseline: string[] = [],
) {
  const group = { ...createGroup(input.leader, input.seats), baseline }
  await Storage.write(key(sessionID), group)
  return published(sessionID, group)
}

export async function join(sessionID: string, input: SeatInput & { product: string }) {
  return mutate(sessionID, (group) => addSeat(group, input))
}

export async function leave(sessionID: string, seatID: string) {
  return mutate(sessionID, (group) => removeSeat(group, seatID))
}

export async function update(sessionID: string, seatID: string, input: Partial<SeatInput>) {
  return mutate(sessionID, (group) => updateSeat(group, seatID, input))
}

/** Keeps the session id a member's product returned, so its next task resumes it */
export async function remember(sessionID: string, seatID: string, privateSessionID: string) {
  return mutate(sessionID, (group) => setPrivateSession(group, seatID, privateSessionID))
}

export async function record(sessionID: string, result: Omit<Result, "at">) {
  return mutate(sessionID, (group) => addResult(group, result))
}
