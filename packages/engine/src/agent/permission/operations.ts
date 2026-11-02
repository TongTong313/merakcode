import { Text } from "../prompt/text"
import { SessionStore } from "../session/store"
import { SessionMode } from "./mode"
import { PermissionNext } from "./next"
import { PermissionExecution } from "./execution"
import { NamedError } from "@merakcode/util/error"
import z from "zod"

/** Active calls and background processes are evaluated against the latest policy before a mode switch settles. */
export namespace ModeOperations {
  export const PendingError = NamedError.create("ModeOperationPendingError", z.object({ message: z.string() }))
  const orchestration = new Set(["subagent", "delegate", "question", "plan_enter"])
  type Operation = {
    sessionID: string
    tool: string
    controller: AbortController
    checks: PermissionNext.Check[]
    sandboxed?: boolean
    rules?: () => Promise<PermissionNext.Ruleset>
    done: Promise<void>
  }
  const active = new Map<string, Operation>()

  export function register(
    sessionID: string,
    callID: string,
    tool: string,
    controller: AbortController,
    rules?: () => Promise<PermissionNext.Ruleset>,
  ) {
    const settled = Promise.withResolvers<void>()
    const key = `${sessionID}:${callID}`
    active.set(key, { sessionID, tool, controller, checks: [], rules, done: settled.promise })
    return () => {
      active.delete(key)
      settled.resolve()
    }
  }

  export function record(sessionID: string, callID: string | undefined, checks: PermissionNext.Check[]) {
    active.get(`${sessionID}:${callID}`)?.checks.push(...checks)
  }

  export function sandbox(sessionID: string, callID: string | undefined, sandboxed: boolean) {
    const operation = active.get(`${sessionID}:${callID}`)
    if (operation) operation.sandboxed = sandboxed
  }

  export function inherit(sessionID: string, from: string | undefined, to: string) {
    const source = active.get(`${sessionID}:${from}`)
    const target = active.get(`${sessionID}:${to}`)
    if (source && target)
      Object.assign(target, { checks: [...source.checks], rules: source.rules, sandboxed: source.sandboxed })
  }

  function rootOf(sessionID: string) {
    const visited = new Set<string>()
    let session = SessionStore.find(sessionID)
    while (session?.parentID && !visited.has(session.id)) {
      visited.add(session.id)
      session = SessionStore.find(session.parentID)
    }
    return session?.id ?? sessionID
  }

  export async function reconcile(rootID: string, mode: SessionMode.Value, revision: number) {
    const isCurrent = () => {
      const session = SessionStore.find(rootID)
      return session?.sessionMode === mode && (session.modeRevision ?? 0) === revision
    }
    if (!isCurrent()) return
    if (mode === "auto") return
    const sandboxMode = await PermissionExecution.mode()
    const affected = (
      await Promise.all(
        [...active.entries()].map(async ([key, operation]) => {
          if (rootOf(operation.sessionID) !== rootID || orchestration.has(operation.tool)) return undefined
          const rules = await operation.rules?.()
          const forbidden =
            !SessionMode.allowsTool(mode, operation.tool) ||
            (operation.checks.length > 0 &&
              (!rules ||
                operation.checks.some(
                  (check) => PermissionNext.evaluate(check.permission, check.pattern, rules).action !== "allow",
                ))) ||
            (sandboxMode !== "off" && operation.sandboxed === false)
          return forbidden ? { key, operation } : undefined
        }),
      )
    ).filter((item) => item !== undefined)
    // Rule providers can await I/O. A newer switch supersedes this decision before any cancellation is sent.
    if (!isCurrent()) return
    for (const { operation } of affected)
      operation.controller.abort(new Error("Operation interrupted by session mode change"))
    for (const { key, operation } of affected)
      await PermissionNext.abortTool(operation.sessionID, key.slice(operation.sessionID.length + 1))
    const pendingMessage = await Text.pick({
      zh: "新模式已生效，但仍有操作尚未确认中止。",
      en: "The new policy is active, but an operation has not confirmed cancellation.",
    })
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      await Promise.race([
        Promise.all(affected.map(({ operation }) => operation.done)),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(
            () =>
              reject(
                new PendingError({
                  message: pendingMessage,
                }),
              ),
            3000,
          )
        }),
      ])
    } finally {
      if (timer) clearTimeout(timer)
    }
  }
}
