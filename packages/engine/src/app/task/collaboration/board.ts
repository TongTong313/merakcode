/**
 * A group chat record: who is in it, when people joined, left or were renamed, and the members' results for the
 * current request. The conversation itself is the session's messages; these functions return a new record.
 */

import type { Text } from "@merakcode/util/text"

export type Seat = {
  id: string
  name: string
  /** Short title such as product manager; may be empty */
  role: string
  /** What the seat is for, in the user's words; it goes into the seat's prompt. May be empty */
  duty: string
  product: string
  leader: boolean
  privateSessionID?: string
}

/** A membership change, shown as a system line in the chat */
export type Event = { at: number; kind: "join" | "leave" | "rename"; names: string[] }

/** A member's final reply to the current user request; a member reads the others' before it starts */
export type Result = { seatID: string; name: string; text: string; requestID: string; at: number }

export type Group = {
  seats: Seat[]
  events: Event[]
  results: Result[]
  /** Paths that were already dirty when the group was created, left out of its changed files */
  baseline: string[]
  seq: number
}

export type SeatInput = { name: string; role?: string; duty?: string }

/** A refused change; the user reads text in their language, logs keep the English */
export class GroupError extends Error {
  constructor(readonly text: Text.Pair) {
    super(text.en)
    this.name = "GroupError"
  }
}

const NOT_FOUND = { zh: "没有这个成员", en: "Seat not found" }
const TAKEN = { zh: "已有成员叫这个名字", en: "Another member already has this name" }

/** A new group: the Merak leader plus any seats named up front, announced in one system line */
export function createGroup(leader: SeatInput, seats: (SeatInput & { product: string })[] = []): Group {
  assertName(leader.name)
  const group: Group = { seats: [], events: [], results: [], baseline: [], seq: 1 }
  group.seats.push({ id: next(group), ...fields(leader), product: "merak", leader: true })
  for (const seat of seats) place(group, seat)
  if (seats.length) group.events.push({ at: Date.now(), kind: "join", names: seats.map((seat) => seat.name) })
  return group
}

export function addSeat(group: Group, input: SeatInput & { product: string }): Group {
  const nextGroup = place(clone(group), input)
  nextGroup.events.push({ at: Date.now(), kind: "join", names: [input.name] })
  return nextGroup
}

export function removeSeat(group: Group, seatID: string): Group {
  const seat = group.seats.find((item) => item.id === seatID)
  if (!seat) throw new GroupError(NOT_FOUND)
  if (seat.leader) throw new GroupError({ zh: "群主不能移出", en: "The Merak leader cannot be removed" })
  const nextGroup = clone(group)
  nextGroup.seats = nextGroup.seats.filter((item) => item.id !== seatID)
  nextGroup.events.push({ at: Date.now(), kind: "leave", names: [seat.name] })
  return nextGroup
}

/** Changes a seat's name, role or duty. The private session stays on the seat. */
export function updateSeat(group: Group, seatID: string, input: Partial<SeatInput>): Group {
  const nextGroup = clone(group)
  const seat = nextGroup.seats.find((item) => item.id === seatID)
  if (!seat) throw new GroupError(NOT_FOUND)
  if (input.name !== undefined && input.name !== seat.name) {
    assertName(input.name)
    if (group.seats.some((item) => item.name === input.name)) throw new GroupError(TAKEN)
    nextGroup.events.push({ at: Date.now(), kind: "rename", names: [seat.name, input.name] })
    seat.name = input.name
  }
  if (input.role !== undefined) seat.role = input.role.trim()
  if (input.duty !== undefined) seat.duty = input.duty.trim()
  return nextGroup
}

export function setPrivateSession(group: Group, seatID: string, privateSessionID: string): Group {
  const nextGroup = clone(group)
  const seat = nextGroup.seats.find((item) => item.id === seatID)
  if (!seat) throw new GroupError(NOT_FOUND)
  seat.privateSessionID = privateSessionID
  return nextGroup
}

/** Keeps only the results of this request, so the record does not grow with the conversation */
export function addResult(group: Group, result: Omit<Result, "at">): Group {
  const nextGroup = clone(group)
  nextGroup.results = [
    ...nextGroup.results.filter((item) => item.requestID === result.requestID),
    { ...result, at: Date.now() },
  ]
  return nextGroup
}

/** A name is one word without spaces or @, so it can be mentioned as @name */
function assertName(name: string) {
  if (!/^[^\s@]+$/u.test(name))
    throw new GroupError({ zh: "姓名里不能有空格或 @", en: "Name must be one word without spaces or @" })
}

function fields(input: SeatInput) {
  return { name: input.name, role: input.role?.trim() ?? "", duty: input.duty?.trim() ?? "" }
}

/** Adds a seat to group in place */
function place(group: Group, input: SeatInput & { product: string }) {
  assertName(input.name)
  if (!input.product.trim()) throw new GroupError({ zh: "请选择产品", en: "Product is required" })
  if (group.seats.some((seat) => seat.name === input.name)) throw new GroupError(TAKEN)
  group.seats.push({ id: next(group), ...fields(input), product: input.product, leader: false })
  return group
}

function next(group: Group) {
  group.seq += 1
  return `s${group.seq}`
}

function clone(group: Group): Group {
  return {
    seats: group.seats.map((seat) => ({ ...seat })),
    events: group.events.map((event) => ({ ...event, names: [...event.names] })),
    results: group.results.map((item) => ({ ...item })),
    baseline: [...group.baseline],
    seq: group.seq,
  }
}
