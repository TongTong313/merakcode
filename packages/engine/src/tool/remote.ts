/**
 * Remote tools are defined and executed in the SDK host process; the engine only forwards calls and hands the results
 * back to the model.
 *
 * - The host registers tools (name, description, JSON Schema of the parameters) through `PUT /tool/remote`; the
 *   registration applies to the whole engine process
 * - When the model calls one, the engine publishes `tool.remote.call` and the host returns the result through
 *   `POST /tool/remote/{callID}`
 * - Approval works like plugin tools (by tool name); argument validation and output truncation match built-in tools.
 *   Pending calls end with an error when they are aborted or the host registers again
 */
import z from "zod"
import { BusEvent } from "../bus/bus-event"
import { Bus } from "../bus"
import { Log } from "@merakcode/log/logger"
import { Tool } from "./tool"

export namespace RemoteTool {
  const log = Log.create({ service: "tool.remote" })
  const REREGISTERED = "The host registered the tool again, so this call was dropped"
  const INTERRUPTED = "The call was interrupted"

  export const Definition = z.object({
    id: z.string().regex(/^[A-Za-z][A-Za-z0-9_-]{0,63}$/),
    description: z.string(),
    /** JSON Schema of the parameters (an object type) */
    parameters: z.record(z.string(), z.unknown()),
  })
  export type Definition = z.infer<typeof Definition>

  export const Result = z.union([
    z.object({ output: z.string(), title: z.string().optional() }),
    z.object({ error: z.string() }),
  ])
  export type Result = z.infer<typeof Result>

  export const Event = {
    Call: BusEvent.define(
      "tool.remote.call",
      z.object({
        callID: z.string(),
        tool: z.string(),
        args: z.unknown(),
        sessionID: z.string(),
        messageID: z.string(),
      }),
    ),
  }

  let definitions: Definition[] = []
  /** Incremented on every registration; calls started before it (perhaps still awaiting approval) are discarded */
  let generation = 0
  const pending = new Map<string, { resolve: (result: Result) => void }>()

  export function set(next: Definition[]) {
    definitions = next
    generation++
    for (const call of pending.values()) call.resolve({ error: REREGISTERED })
    pending.clear()
    log.info("remote tools registered", { count: next.length })
  }

  export function list(): readonly Definition[] {
    return definitions
  }

  /** Delivers the host's result; returns false when no call is waiting (aborted or discarded) */
  export function settle(callID: string, result: Result) {
    const call = pending.get(callID)
    if (!call) return false
    pending.delete(callID)
    call.resolve(result)
    return true
  }

  /**
   * Built with Tool.define like built-in tools: arguments are validated against the host's JSON Schema and long output
   * is truncated
   */
  export function info(definition: Definition): Tool.Info {
    const born = generation
    return Tool.define(definition.id, {
      description: definition.description,
      parameters: z.fromJSONSchema(definition.parameters as Parameters<typeof z.fromJSONSchema>[0]),
      execute: async (args, ctx) => {
        await ctx.ask({ permission: definition.id, patterns: ["*"], metadata: { remoteTool: true } })
        const callID = ctx.callID ?? crypto.randomUUID()
        const result = await new Promise<Result>((resolve) => {
          // The call may have been aborted during approval; the abort event has already fired and a listener would
          // never run
          if (ctx.abort.aborted) return resolve({ error: INTERRUPTED })
          if (born !== generation) return resolve({ error: REREGISTERED })
          const abort = () => settle(callID, { error: INTERRUPTED })
          ctx.abort.addEventListener("abort", abort, { once: true })
          pending.set(callID, {
            resolve: (value) => {
              ctx.abort.removeEventListener("abort", abort)
              resolve(value)
            },
          })
          void Bus.publish(Event.Call, {
            callID,
            tool: definition.id,
            args,
            sessionID: ctx.sessionID,
            messageID: ctx.messageID,
          })
        })
        if ("error" in result) throw new Error(result.error)
        return { title: result.title ?? "", output: result.output, metadata: { remoteTool: true } }
      },
    })
  }
}
