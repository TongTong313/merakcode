import { Loop } from "./index"
import { LoopExecution } from "./execution"
import { LoopStatus } from "./status"
import { Log } from "@merakcode/log/logger"
import { Message } from "../session/message"
import { Checkout } from "../../infra/project/checkout"
import { ExternalSession } from "./external"
import { SessionTarget } from "../session/target"

/**
 * Request entry point shared by HTTP and in-process callers. Each request gets its own execution scope; cancelling
 * tears down the whole scope tree.
 */
export namespace LoopRequest {
  const log = Log.create({ service: "session.dispatch" })
  const requests = new Map<string, LoopExecution.Scope>()
  const barriers = new Map<string, Promise<void>>()

  export async function command(input: Loop.CommandInput) {
    await SessionTarget.assertNativeOperation(input.sessionID)
    try {
      return await local("command", input.sessionID, () => Loop.command(input))
    } catch (error) {
      // Keep the public cancellation error unchanged.
      if (error instanceof Error && error.name === "AbortError")
        throw new Message.AbortedError({ message: "Operation aborted by user" })
      throw error
    }
  }

  export function prompt(input: Loop.PromptInput) {
    return local("prompt", input.sessionID, async () => {
      const session = await SessionTarget.assertCanSend(input.sessionID, input)
      return session.target?.kind === "external" ? ExternalSession.prompt(input) : Loop.prompt(input)
    })
  }

  function local<T>(kind: "command" | "prompt", sessionID: string, execute: () => Promise<T>): Promise<T> {
    // Each SDK callback owns its loop binding. Same-session callbacks stay within
    // the outer cancellation tree; otherwise a queued callback can outlive it.
    const inherited = LoopExecution.current(sessionID)
    LoopExecution.check(sessionID)
    const releaseCheckout = Checkout.hold()
    const scope = LoopExecution.create({
      id: crypto.randomUUID(),
      sessionID,
      parent: inherited && LoopExecution.active(inherited) ? inherited : undefined,
    })
    requests.set(scope.id, scope)
    const release = LoopStatus.hold(sessionID)
    LoopStatus.set(sessionID, { type: "busy" })
    const started = Date.now()
    const context = {
      kind,
      sessionID,
      requestID: scope.id,
      parentRequestID: inherited?.id,
    }
    return LoopExecution.run(scope, async () => {
      log.info("request preparing", context)
      try {
        for (;;) {
          const barrier = barriers.get(sessionID)
          if (!barrier) break
          await LoopExecution.wait(() => barrier, sessionID)
        }
        LoopExecution.check(sessionID)
        log.info("request executing", context)
        const result = await LoopExecution.wait(execute, sessionID)
        await LoopExecution.wait(() => LoopExecution.settleChildren(scope), sessionID)
        return result
      } finally {
        await LoopExecution.cancelChildren(scope)
        await ExternalSession.settleOwner(scope.id)
        requests.delete(scope.id)
        LoopExecution.finish(scope)
        release()
        if (![...requests.values()].some((entry) => entry.sessionID === sessionID) && !Loop.resume(sessionID))
          LoopStatus.set(sessionID, { type: "idle" })
        log.info("request ended", {
          ...context,
          cancelled: scope.controller.signal.aborted,
          duration: Date.now() - started,
        })
      }
    }).finally(releaseCheckout)
  }

  export async function cancel(sessionID: string): Promise<void> {
    const started = Date.now()
    let release!: () => void
    const previous = barriers.get(sessionID)
    const barrier = new Promise<void>((resolve) => (release = resolve))
    barriers.set(sessionID, barrier)
    const loop = Loop.interruptAndSettle(sessionID)
    log.info("cancel started", { sessionID })
    try {
      await Promise.all([previous, loop])
    } finally {
      if (barriers.get(sessionID) === barrier) barriers.delete(sessionID)
      release()
      log.info("cancel ended", { sessionID, duration: Date.now() - started })
    }
  }
}
