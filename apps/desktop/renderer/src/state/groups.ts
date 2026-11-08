import { createSignal } from "solid-js"
import { z } from "zod"
import {
  applyToBoard,
  applyToInbox,
  emptyBoard,
  emptyInbox,
  foldSession,
  EngineEventSchema,
  type Board,
  type EngineEvent,
  type GroupGroup,
  type GroupMember,
  type Inbox,
  type SessionState,
} from "@merakcode/sdk"
import { client, onConnection, type EngineClient } from "./client"
import { bridge, log, storage } from "../lib/bridge"

export const localHuman = "local-human"
const [groups, setGroups] = createSignal<GroupGroup[]>([])
export { groups }
type GroupView = {
  group?: GroupGroup
  members: GroupMember[]
  events: EngineEvent[]
  board: Board
  inbox: Inbox
  lastSeq: number
  activity: Record<string, { member: string; task?: string; status: string; sequence: number }>
}
const [views, setViews] = createSignal<Record<string, GroupView>>({})
const watching = new Map<string, { connection: EngineClient; ready: Promise<void> }>()
export const groupView = (id: string) => views()[id]
const [readSequences, setReadSequences] = createSignal<Record<string, number>>({})
const [readNotices, setReadNotices] = createSignal<string[]>([])
let readReady: Promise<void> | undefined
let readWrites = Promise.resolve()
const readKey = "group-read-sequences"
const noticesKey = "group-notices-read"

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
    .catch(failed)
}

export function unreadGroup(id: string) {
  const after = readSequences()[id] ?? 0
  return (groupView(id)?.events ?? []).filter(
    (event) => event.type === "notice.sent" && event.payload.to?.includes(localHuman) && (event.seq ?? 0) > after,
  ).length
}

export function markGroupRead(id: string, sequence: number) {
  if (sequence <= (readSequences()[id] ?? 0)) return
  const next = { ...readSequences(), [id]: sequence }
  setReadSequences(next)
  readWrites = readWrites.then(() => storage.set(readKey, next)).catch(failed)
}

export async function loadGroups() {
  await loadReadSequences()
  const connection = await client()
  const facts = await connection.events.find({ types: ["group.created"] })
  const list = (facts ?? []).flatMap((fact) => {
    const event = EngineEventSchema.parse(fact)
    return event.type === "group.created" && event.payload.members?.some((member) => member.id === localHuman)
      ? [event.payload.group]
      : []
  })
  setGroups(list)
  await Promise.all(list.map((group) => loadGroup(group.id)))
  setGroups((all) => all.map((group) => groupView(group.id)?.group ?? group))
}

export function connectGroups() {
  const stopNotices = bridge?.onReadNotices(mergeReadNotices)
  const stopConnection = onConnection((connection) => {
    if (!connection) return
    void connection.events
      .subscribe({ types: ["group.created"] }, () => {
        void loadGroups().catch(failed)
      })
      .then(() => loadGroups())
      .catch(failed)
  })
  return () => {
    stopNotices?.()
    stopConnection()
  }
}

function failed() {
  log("error", "group history request failed", { code: "MRK-1003" })
}

export async function loadGroup(id: string) {
  await loadReadSequences()
  const connection = await client()
  const previous = watching.get(id)
  if (previous?.connection === connection) return previous.ready
  const ready = watch(connection, id)
  watching.set(id, { connection, ready })
  void ready.catch(() => {
    if (watching.get(id)?.ready === ready) watching.delete(id)
  })
  return ready
}

async function watch(connection: EngineClient, id: string) {
  let current: GroupView = {
    members: [],
    events: [],
    board: emptyBoard(),
    inbox: emptyInbox(),
    lastSeq: 0,
    activity: {},
  }
  let ready = false
  const pending: EngineEvent[] = []
  let queue = Promise.resolve()
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
    if (event.stream.startsWith("session:") && event.scope.session && event.seq) {
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
    let members = current.members
    if (event.type === "group.created") members = event.payload.members ?? []
    if (event.type === "member.added")
      members = [...members.filter((member) => member.id !== event.payload.id), event.payload]
    current = {
      ...current,
      members,
      group:
        event.type === "group.created"
          ? event.payload.group
          : event.type === "group.updated"
            ? event.payload
            : current.group,
      board: applyToBoard(current.board, event),
      inbox: applyToInbox(current.inbox, event, localHuman),
      lastSeq: event.seq,
      events: [...current.events, event],
    }
  }
  const catchUp = async () => {
    for (;;) {
      const facts = await connection.events.read({ stream: `group:${id}`, from: current.lastSeq + 1, limit: 256 })
      for (const fact of facts ?? []) apply(EngineEventSchema.parse(fact))
      if (!facts || facts.length < 256) break
    }
  }
  const catchUpActivity = async () => {
    const threads = new Map<string, string>()
    for (const event of current.events) {
      if (event.type === "thread.started" || event.type === "thread.handed_over")
        threads.set(event.payload.key, event.payload.session)
    }
    const sessions = new Set(threads.values())
    await Promise.all(
      [...sessions].map(async (session) => {
        const created = await connection.events.read({ stream: `session:${session}`, from: 1, limit: 1 })
        if (!created?.length) return
        let state = await connection.session.snapshot({ session })
        for (;;) {
          const facts = await connection.events.read({
            stream: `session:${session}`,
            from: state.lastSeq + 1,
            limit: 256,
          })
          for (const fact of facts ?? []) state = foldSession(state, EngineEventSchema.parse(fact))!
          if (!facts || facts.length < 256) break
        }
        snapshotActivity(state)
      }),
    )
  }
  const publish = () => {
    setViews((all) => ({ ...all, [id]: current }))
    if (current.group) setGroups((all) => all.map((group) => (group.id === id ? current.group! : group)))
  }
  const unsubscribe = await connection.events.subscribe({ scope: { group: id } }, (event) => {
    if (!ready) {
      pending.push(event)
      return
    }
    queue = queue
      .then(async () => {
        if (
          event.type === "events.lagged" ||
          (event.stream === `group:${id}` && (event.seq ?? 0) > current.lastSeq + 1)
        ) {
          await catchUp()
          await catchUpActivity()
        }
        apply(event)
        publish()
      })
      .catch(() => {
        void connection.close()
      })
  })
  try {
    await catchUp()
    await catchUpActivity()
    for (const event of pending) {
      if (
        event.type === "events.lagged" ||
        (event.stream === `group:${id}` && (event.seq ?? 0) > current.lastSeq + 1)
      ) {
        await catchUp()
        await catchUpActivity()
      }
      apply(event)
    }
    ready = true
    publish()
  } catch (error) {
    await unsubscribe().catch(() => {})
    throw error
  }
}
