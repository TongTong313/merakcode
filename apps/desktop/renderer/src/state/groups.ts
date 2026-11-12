import { createSignal } from "solid-js"
import { z } from "zod"
import {
  applyToAssignments,
  applyToBoard,
  applyToInbox,
  applyToMembers,
  emptyAssignments,
  emptyBoard,
  emptyInbox,
  foldSession,
  EngineEventSchema,
  type Assignments,
  type Board,
  type EngineEvent,
  type GroupGroup,
  type GroupMember,
  type Inbox,
  type Notice,
  type SessionState,
} from "@merakcode/sdk"
import { client, localHuman, onConnection, type EngineClient } from "./client"
import { listen } from "./store"
import { bridge, log, storage } from "../lib/bridge"

export { localHuman }
const [groups, setGroups] = createSignal<GroupGroup[]>([])
export { groups }

type GroupActivity = { member: string; task?: string; status: string; sequence: number }
type GroupView = {
  group?: GroupGroup
  members: GroupMember[]
  /** Group history in arrival order; the array is appended to in place, a new view object announces each change. */
  events: EngineEvent[]
  board: Board
  inbox: Inbox
  assignments: Assignments
  lastSeq: number
  /** The session of the Leader thread, which holds the Leader's replies and tool calls. */
  leader?: { session: string; member: string }
  activity: Record<string, GroupActivity>
  /** Time of the newest event of the group, in milliseconds. */
  updated: number
}

const [views, setViews] = createSignal<Record<string, GroupView>>({})
export const groupView = (id: string) => views()[id]

type Watch = {
  ready: Promise<void>
  push: (event: EngineEvent) => void
  stop: () => void
}
const watches = new Map<string, Watch>()

const [readSequences, setReadSequences] = createSignal<Record<string, number>>({})
const [readNotices, setReadNotices] = createSignal<string[]>([])
let readReady: Promise<void> | undefined
let readWrites = Promise.resolve()
const readKey = "group-read-sequences"
const noticesKey = "group-notices-read"

function failed(code = "MRK-1003") {
  log("error", "group history request failed", { code })
}

function loadReadSequences() {
  return (readReady ??= Promise.all([
    storage.get<unknown>(readKey, {}),
    bridge ? bridge.getReadNotices() : storage.get<unknown>(noticesKey, []),
  ]).then(([saved, notices]) => {
    const parsed = z.record(z.string(), z.number().int().nonnegative()).safeParse(saved)
    if (parsed.success) setReadSequences(parsed.data)
    mergeReadNotices(notices)
  }))
}

export const noticeRead = (id: string) => readNotices().includes(id)

function mergeReadNotices(ids: unknown) {
  const parsed = z.array(z.string()).safeParse(ids)
  if (parsed.success) setReadNotices((known) => [...new Set([...known, ...parsed.data])])
}

export function markNoticeRead(id: string) {
  markNoticesRead([id])
}

export function markNoticesRead(ids: string[]) {
  const added = ids.filter((id) => !noticeRead(id))
  if (!added.length) return
  mergeReadNotices(added)
  readWrites = readWrites
    .then(async () => {
      if (bridge) mergeReadNotices(await bridge.markNoticesRead(added))
      else await storage.set(noticesKey, readNotices())
    })
    .catch(() => failed())
}

/** Notices addressed to this person that they have not opened: the group's notices after its read mark. */
export function unreadGroup(id: string) {
  const after = readSequences()[id] ?? 0
  return (groupView(id)?.events ?? []).filter(
    (event) =>
      event.type === "notice.sent" &&
      event.payload.to?.includes(localHuman) &&
      (event.stream.startsWith("inbox:") ? !noticeRead(event.id) : (event.seq ?? 0) > after),
  ).length
}

export function markGroupRead(id: string, sequence: number) {
  if (sequence <= (readSequences()[id] ?? 0)) return
  const next = { ...readSequences(), [id]: sequence }
  setReadSequences(next)
  readWrites = readWrites.then(() => storage.set(readKey, next)).catch(() => failed())
}

/** The notices of this person's own inbox stream, which belong to no group (schedules, imports). */
const [personal, setPersonal] = createSignal<Inbox>(emptyInbox())

export type HomeNotice = { notice: Notice; group?: GroupGroup; pending: boolean }

/** Every notice addressed to this person, newest first; pending ones are those that wait for a decision. */
export function homeNotices(): HomeNotice[] {
  const named = (id: string | undefined) => groups().find((group) => group.id === id)
  const sources: { inbox: Inbox; group?: string }[] = [
    { inbox: personal() },
    ...groups().map((group) => ({ inbox: groupView(group.id)?.inbox ?? emptyInbox(), group: group.id })),
  ]
  return sources
    .flatMap(({ inbox, group }) => [
      ...inbox.todo.map((notice) => ({ notice, group: named(notice.scope.group ?? group), pending: true })),
      ...inbox.info.map((notice) => ({ notice, group: named(notice.scope.group ?? group), pending: false })),
    ])
    .filter((entry) => entry.notice.kind !== "receipt")
    .toSorted((a, b) => b.notice.time.localeCompare(a.notice.time) || b.notice.id.localeCompare(a.notice.id))
}

/** The notices the person has not marked read, decisions that wait for them included. Receipts are not counted. */
export function unseenNotices() {
  return homeNotices()
    .filter((entry) => !noticeRead(entry.notice.id))
    .map((entry) => entry.notice.id)
}

/** Reads the groups of this person; their histories load afterwards in the background, a few at a time. */
export async function loadGroups() {
  await loadReadSequences()
  const connection = await client()
  const listed = await connection.group.list()
  const list: GroupGroup[] = (listed ?? []).map(({ tasks: _tasks, ...group }) => group)
  // Cloud groups are not in the engine's own list: their facts are forwarded into its store when signed in
  const status = await connection.cloud.status()
  if (status.account) {
    for (const fact of (await connection.events.find({ types: ["group.created"] })) ?? []) {
      const event = EngineEventSchema.parse(fact)
      if (
        event.type === "group.created" &&
        event.payload.group.kind === "cloud" &&
        event.payload.members?.some((member) => member.id === localHuman) &&
        !list.some((group) => group.id === event.payload.group.id)
      )
        list.push(event.payload.group)
    }
  }
  const visible = new Set(list.map((group) => group.id))
  for (const [id, watch] of watches) {
    if (visible.has(id)) continue
    watch.stop()
  }
  setViews((all) => Object.fromEntries(Object.entries(all).filter(([id]) => visible.has(id))))
  setGroups(list.map((group) => groupView(group.id)?.group ?? group))
  void loadPersonal(connection).catch(() => failed())
  const waiting = list.map((group) => group.id)
  const worker = async () => {
    for (let id = waiting.shift(); id; id = waiting.shift()) await loadGroup(id).catch(() => failed())
  }
  loading = Promise.all([worker(), worker(), worker()]).then(() => undefined)
}

let loading: Promise<void> = Promise.resolve()

/** Settles when the histories of the listed groups have loaded; the list itself is there earlier. */
export const groupsLoaded = () => loading

async function loadPersonal(connection: EngineClient) {
  let inbox = emptyInbox()
  const stream = `inbox:${localHuman}`
  for (;;) {
    const facts = await connection.events.read({ stream, from: (inbox.streams?.[stream] ?? 0) + 1, limit: 256 })
    for (const fact of facts ?? []) inbox = applyToInbox(inbox, EngineEventSchema.parse(fact), localHuman)
    if (!facts || facts.length < 256) break
  }
  setPersonal(inbox)
}

/** Follows the groups: a new group joins the list; every event goes to the view of its own group. */
export function connectGroups() {
  const stopNotices = bridge?.onReadNotices(mergeReadNotices)
  const stopEvents = listen((_directory, event) => void announce(event))
  const stopConnection = onConnection((connection) => {
    // Subscriptions belong to a connection: the views start over on the next one
    for (const watch of [...watches.values()]) watch.stop()
    if (!connection) return
    void loadGroups().catch(() => failed())
  })
  return () => {
    stopNotices?.()
    stopEvents()
    stopConnection()
    for (const watch of [...watches.values()]) watch.stop()
  }
}

let listing = Promise.resolve()

/**
 * What the shared event feed tells about groups as a whole: a new group joins the list, and the person's own inbox
 * changes. The events inside a group reach its own view through the subscription it holds.
 */
async function announce(event: EngineEvent) {
  if (event.stream === `inbox:${localHuman}` && !event.scope.group) {
    setPersonal((inbox) => applyToInbox(inbox, event, localHuman))
    return
  }
  const id = event.scope.group
  if (!id || event.type !== "group.created" || watches.has(id)) return
  listing = listing.then(() => loadGroups()).catch(() => failed())
  await listing
}

/** Hands one engine event to the view of its group. */
export function receiveGroupEvent(event: EngineEvent) {
  const id = event.scope.group
  if (event.type === "events.lagged") for (const watch of watches.values()) watch.push(event)
  else if (id) watches.get(id)?.push(event)
}

export function loadGroup(id: string) {
  return (watches.get(id) ?? start(id)).ready
}

/** Builds the view of one group from its history, then keeps it current; a failure rebuilds this group only. */
function start(id: string, attempt = 1): Watch {
  let current: GroupView = {
    members: [],
    events: [],
    board: emptyBoard(),
    inbox: emptyInbox(),
    assignments: emptyAssignments(),
    lastSeq: 0,
    activity: {},
    updated: 0,
  }
  const known = new Set<string>()
  const pending: EngineEvent[] = []
  let ready = false
  let stopped = false
  let queue = Promise.resolve()
  let connection: EngineClient | undefined

  const remember = (event: EngineEvent) => {
    if (known.has(event.id)) return false
    known.add(event.id)
    current.events.push(event)
    current.updated = Math.max(current.updated, Date.parse(event.time) || 0)
    return true
  }
  const snapshotActivity = (state: SessionState) => {
    if (!state.config.member || state.scope.group !== id) return
    if (!current.members.some((member) => member.id === state.config.member && member.agentRole === "leader")) return
    const previous = current.activity[state.id]
    if (previous && previous.sequence > state.lastSeq) return
    current = {
      ...current,
      activity: {
        ...current.activity,
        [state.id]: {
          member: state.config.member,
          task: state.scope.task,
          status: state.status,
          sequence: state.lastSeq,
        },
      },
    }
  }
  const apply = (event: EngineEvent) => {
    if (event.scope.group === id && (event.stream.startsWith("inbox:") || event.stream.startsWith("device:"))) {
      if (!event.seq || !remember(event)) return
      current = {
        ...current,
        board: applyToBoard(current.board, event),
        inbox: applyToInbox(current.inbox, event, localHuman),
      }
      return
    }
    if (event.stream.startsWith("session:") && event.scope.session && event.seq) {
      if (
        event.type === "turn.finished" ||
        event.type === "session.budget" ||
        event.type === "permission.replied" ||
        event.type === "question.answered"
      ) {
        if (remember(event)) current = { ...current, inbox: applyToInbox(current.inbox, event, localHuman) }
      }
      // What the Leader does on its thread, and when it reads a message, belongs to the group chat
      if (
        (event.type === "message.completed" || event.type === "input.consumed") &&
        event.scope.session === current.leader?.session
      )
        remember(event)
      if (event.type === "session.created") snapshotActivity({ ...event.payload, lastSeq: event.seq })
      if (event.type !== "turn.started" && event.type !== "turn.finished") return
      const previous = current.activity[event.scope.session]
      if (previous && previous.sequence >= event.seq) return
      const member = previous?.member ?? event.actor.id
      if (!member || !current.members.some((item) => item.id === member && item.agentRole === "leader")) return
      current = {
        ...current,
        activity: {
          ...current.activity,
          [event.scope.session]: {
            member,
            task: event.scope.task,
            status: event.type === "turn.started" ? "running" : "idle",
            sequence: event.seq,
          },
        },
      }
      return
    }
    if (event.stream !== `group:${id}` || !event.seq || event.seq <= current.lastSeq) return
    if (event.seq !== current.lastSeq + 1) throw new Error("MRK-1003")
    const board = applyToBoard(current.board, event)
    const inbox = applyToInbox(current.inbox, event, localHuman)
    remember(event)
    current = {
      ...current,
      members: applyToMembers(current.members, event),
      group:
        event.type === "group.created"
          ? event.payload.group
          : event.type === "group.updated"
            ? event.payload
            : current.group,
      board,
      inbox,
      assignments: applyToAssignments(current.assignments, event),
      lastSeq: event.seq,
      leader:
        (event.type === "thread.started" || event.type === "thread.handed_over") && event.payload.key === id
          ? { session: event.payload.session, member: event.payload.leader }
          : current.leader,
    }
  }
  const catchUp = async (active: EngineClient) => {
    for (;;) {
      const facts = await active.events.read({ stream: `group:${id}`, from: current.lastSeq + 1, limit: 256 })
      for (const fact of facts ?? []) apply(EngineEventSchema.parse(fact))
      if (!facts || facts.length < 256) break
    }
  }
  const catchUpActivity = async (active: EngineClient) => {
    const delivered = await active.events.find({ scope: { group: id }, types: ["notice.sent", "task.progress"] })
    for (const fact of delivered ?? []) {
      if (fact.stream.startsWith("inbox:") || fact.stream.startsWith("device:")) apply(EngineEventSchema.parse(fact))
    }
    const usage = await active.events.find({
      scope: { group: id },
      types: ["turn.finished", "session.budget", "permission.replied", "question.answered"],
    })
    for (const event of usage ?? []) apply(EngineEventSchema.parse(event))
    const sessions = new Set<string>()
    for (const event of current.events) {
      if (event.type === "thread.started" || event.type === "thread.handed_over") sessions.add(event.payload.session)
    }
    await Promise.all(
      [...sessions].map(async (session) => {
        const created = await active.events.read({ stream: `session:${session}`, from: 1, limit: 1 })
        if (!created?.length) return
        const chat = await active.events.find({ scope: { session }, types: ["message.completed", "input.consumed"] })
        for (const fact of chat ?? []) apply(EngineEventSchema.parse(fact))
        let state = await active.session.snapshot({ session })
        for (;;) {
          const facts = await active.events.read({ stream: `session:${session}`, from: state.lastSeq + 1, limit: 256 })
          for (const fact of facts ?? []) state = foldSession(state, EngineEventSchema.parse(fact))!
          if (!facts || facts.length < 256) break
        }
        snapshotActivity(state)
      }),
    )
  }
  const publish = () => {
    if (stopped) return
    current = { ...current }
    setViews((all) => ({ ...all, [id]: current }))
    if (current.group) setGroups((all) => all.map((group) => (group.id === id ? current.group! : group)))
  }
  const handle = async (event: EngineEvent) => {
    if (event.type === "events.lagged" || (event.stream === `group:${id}` && (event.seq ?? 0) > current.lastSeq + 1)) {
      await catchUp(connection!)
      await catchUpActivity(connection!)
    }
    apply(event)
    publish()
  }
  const stop = () => {
    stopped = true
    if (watches.get(id) === watch) watches.delete(id)
  }
  /** Only this group starts over; the connection and the other groups are not touched. */
  const rebuild = () => {
    if (stopped) return
    failed()
    watch.stop()
    if (attempt >= 5) return
    setTimeout(() => {
      if (!watches.has(id) && groups().some((group) => group.id === id)) start(id, attempt + 1).ready.catch(() => {})
    }, 250 * attempt)
  }
  const push = (event: EngineEvent) => {
    if (stopped) return
    if (!ready) {
      pending.push(event)
      return
    }
    queue = queue.then(() => handle(event)).catch(rebuild)
  }
  let unsubscribe: (() => Promise<void>) | undefined
  const watch: Watch = {
    ready: Promise.resolve(),
    push,
    stop: () => {
      stop()
      void unsubscribe?.().catch(() => undefined)
    },
  }
  watches.set(id, watch)
  watch.ready = (async () => {
    connection = await client()
    unsubscribe = await connection.events.subscribe({ scope: { group: id } }, push)
    await catchUp(connection)
    await catchUpActivity(connection)
    for (const event of pending.splice(0)) await handle(event)
    ready = true
    publish()
  })().catch((error: unknown) => {
    watch.stop()
    throw error
  })
  return watch
}
