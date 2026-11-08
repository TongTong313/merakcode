import type { connect } from "./client"
import { EngineEventSchema, type EngineEvent } from "./protocol.gen"
import { createConversation, foldConversation, type Conversation } from "./fold/conversation"

/** Subscribes before loading a checkpoint, then fills sequence gaps from durable history. */
export async function watchConversation(
  client: Awaited<ReturnType<typeof connect>>,
  session: string,
  changed: (value: Conversation) => void,
  failed: (error: unknown) => void = () => {
    void client.close()
  },
) {
  let current: Conversation | undefined
  let ready = false
  let active = true
  const buffered: EngineEvent[] = []
  let queue = Promise.resolve()

  const catchUp = async () => {
    if (!current) current = createConversation(await client.session.snapshot({ session }))
    for (;;) {
      const events = await client.events.read({
        stream: `session:${session}`,
        from: current.state.lastSeq + 1,
        limit: 256,
      })
      for (const event of events ?? []) current = foldConversation(current, EngineEventSchema.parse(event))
      if (!events || events.length < 256) break
    }
  }

  const apply = async (event: EngineEvent) => {
    if (!active || !current) return
    if (event.type === "events.lagged" || (event.seq && event.seq > current.state.lastSeq + 1)) {
      current = { ...current, live: undefined }
      await catchUp()
    }
    if (
      event.type === "message.delta" &&
      (current.state.status !== "running" || event.scope.turn !== current.state.scope.turn)
    )
      return
    current = foldConversation(current, event)
    if (active) changed(current)
  }

  const unsubscribe = await client.events.subscribe({ scope: { session } }, (event) => {
    if (!ready) {
      buffered.push(event)
      return
    }
    queue = queue
      .then(() => apply(event))
      .catch((error) => {
        if (active) failed(error)
      })
  })
  try {
    await catchUp()
    for (const event of buffered) await apply(event)
    ready = true
    changed(current!)
  } catch (error) {
    active = false
    await unsubscribe().catch(() => {})
    throw error
  }
  return {
    close: async () => {
      active = false
      await unsubscribe()
      await queue
    },
  }
}
