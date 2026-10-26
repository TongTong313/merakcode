import { SessionRunner } from "./runner"
import { SessionExecution } from "./execution"
import { SessionStatus } from "./status"
import { Log } from "@merakcode/log/logger"
import { Message } from "./message"
import { Checkout } from "../project/checkout"

/**
 * Request entry point shared by HTTP and in-process callers. Each request gets its own execution scope; cancelling
 * tears down the whole scope tree.
 */
export namespace SessionDispatch {
  const log = Log.create({ service: "session.dispatch" })
  const requests = new Map<string, SessionExecution.Scope>()
  const barriers = new Map<string, Promise<void>>()

  export async function command(input: SessionRunner.CommandInput) {
    try {
      return await local("command", input.sessionID, () => SessionRunner.command(input))
    } catch (error) {
      // Keep the public cancellation error unchanged.
      if (error instanceof Error && error.name === "AbortError")
        throw new Message.AbortedError({ message: "Operation aborted by user" })
      throw error
    }
  }

  export function prompt(input: SessionRunner.PromptInput) {
    return local("prompt", input.sessionID, () => SessionRunner.prompt(input))
  }

  function local<T>(kind: "command" | "prompt", sessionID: string, execute: () => Promise<T>): Promise<T> {
    // Each SDK callback owns its loop binding. Same-session callbacks stay within
    // the outer cancellation tree; otherwise a queued callback can outlive it.
    const inherited = SessionExecution.current(sessionID)
    SessionExecution.check(sessionID)
    const releaseCheckout = Checkout.hold()
    const scope = SessionExecution.create({
      id: crypto.randomUUID(),
      sessionID,
      parent: inherited && SessionExecution.active(inherited) ? inherited : undefined,
    })
    requests.set(scope.id, scope)
    const release = SessionStatus.hold(sessionID)
    SessionStatus.set(sessionID, { type: "busy" })
    const started = Date.now()
    const context = {
      kind,
      sessionID,
      requestID: scope.id,
      parentRequestID: inherited?.id,
    }
    return SessionExecution.run(scope, async () => {
      log.info("request preparing", context)
      try {
        for (;;) {
          const barrier = barriers.get(sessionID)
          if (!barrier) break
          await SessionExecution.wait(() => barrier, sessionID)
        }
        SessionExecution.check(sessionID)
        log.info("request executing", context)
        const result = await SessionExecution.wait(execute, sessionID)
        await SessionExecution.wait(() => SessionExecution.settleChildren(scope), sessionID)
        return result
      } finally {
        await SessionExecution.cancelChildren(scope)
        requests.delete(scope.id)
        SessionExecution.finish(scope)
        release()
        if (![...requests.values()].some((entry) => entry.sessionID === sessionID) && !SessionRunner.resume(sessionID))
          SessionStatus.set(sessionID, { type: "idle" })
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
    const loop = SessionRunner.interruptAndSettle(sessionID)
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
