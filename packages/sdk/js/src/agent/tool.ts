/**
 * Tools defined in the host process: when the model calls one, the engine forwards the call to the host over the event
 * stream and the host runs it and sends back the result.
 */
import { z } from "zod"
import type { MerakCodeClient } from "../client/index.js"
import type { Event } from "../client/gen/types.gen.js"
import { fromResponse } from "../errors.js"

export type ToolRunContext = {
  sessionID: string
  messageID: string
  callID: string
}

export type HostTool<Args extends z.ZodRawShape = z.ZodRawShape> = {
  name: string
  description: string
  args: Args
  run(args: z.infer<z.ZodObject<Args>>, context: ToolRunContext): Promise<string> | string
}

export function tool<Args extends z.ZodRawShape>(definition: HostTool<Args>): HostTool<Args> {
  return definition
}

/** Registers the tools and handles calls forwarded by the engine in the background. Returns a function that stops it */
export async function serveTools(client: MerakCodeClient, tools: HostTool[]) {
  const byName = new Map(tools.map((item) => [item.name, item]))
  const registered = await client.tool.remote.register({
    tools: tools.map((item) => ({
      id: item.name,
      description: item.description,
      parameters: z.toJSONSchema(z.object(item.args)) as Record<string, unknown>,
    })),
  })
  if (registered.error) throw fromResponse(registered.error, registered.response)

  const abort = new AbortController()
  const events = await client.global.event({ signal: abort.signal })
  const done = (async () => {
    for await (const raw of events.stream) {
      const event = (raw as { payload?: Event }).payload
      if (event?.type !== "tool.remote.call") continue
      const call = event.properties
      const item = byName.get(call.tool)
      void (async () => {
        const result = await (async () => {
          if (!item) return { error: `The host has no tool named ${call.tool}` } as const
          try {
            const args = z.object(item.args).parse(call.args)
            return {
              output: await item.run(args, {
                sessionID: call.sessionID,
                messageID: call.messageID,
                callID: call.callID,
              }),
            }
          } catch (error) {
            return { error: error instanceof Error ? error.message : String(error) }
          }
        })()
        await client.tool.remote.result({ callID: call.callID, body: result })
      })()
    }
  })().catch(() => undefined)
  return async () => {
    abort.abort()
    await done
  }
}
