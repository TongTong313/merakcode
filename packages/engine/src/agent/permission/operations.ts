import { Text } from "../prompt/text"
import { SessionStore } from "../session/store"
import { PermissionLevel } from "./level"
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
    approved?: PermissionNext.Check[]
    rules?: () => Promise<PermissionNext.Ruleset>
    done: Promise<void>
    stopping?: string
  }
  const active = new Map<string, Operation>()
  const transitions = new Map<string, Set<{ message: string }>>()

  export function block(rootID: string, message: string) {
    const ticket = { message }
    const pending = transitions.get(rootID) ?? new Set<{ message: string }>()
    pending.add(ticket)
    transitions.set(rootID, pending)
    return () => {
      pending.delete(ticket)
      if (pending.size === 0) transitions.delete(rootID)
    }
  }

  export function assertAvailable(sessionID: string) {
    const root = rootOf(sessionID)
    const pending =
      transitions.get(root)?.values().next().value?.message ??
      [...active.values()].find((operation) => rootOf(operation.sessionID) === root && operation.stopping)?.stopping
    if (pending) throw new PendingError({ message: pending })
  }

  export function register(
    sessionID: string,
    callID: string,
    tool: string,
    controller: AbortController,
    rules?: () => Promise<PermissionNext.Ruleset>,
  ) {
    assertAvailable(sessionID)
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

  export function authorize(sessionID: string, callID: string | undefined, admission: PermissionNext.Admission) {
    const operation = active.get(`${sessionID}:${callID}`)
    if (operation) operation.approved = [...(operation.approved ?? []), ...admission.approved]
  }

  export function inherit(sessionID: string, from: string | undefined, to: string) {
    const source = active.get(`${sessionID}:${from}`)
    const target = active.get(`${sessionID}:${to}`)
    if (source && target)
      Object.assign(target, {
        checks: [...source.checks],
        approved: source.approved,
        rules: source.rules,
        sandboxed: source.sandboxed,
      })
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

  export async function reconcile(rootID: string, mode: PermissionLevel.Value, revision: number) {
    const isCurrent = () => {
      const session = SessionStore.find(rootID)
      return session?.permissionLevel === mode && (session.permissionRevision ?? 0) === revision
    }
    if (!isCurrent()) return
    if (mode === "fullTakeover") return
    const affected = (
      await Promise.all(
        [...active.entries()].map(async ([key, operation]) => {
          if (rootOf(operation.sessionID) !== rootID || orchestration.has(operation.tool)) return undefined
          const rules = await operation.rules?.()
          if (operation.checks.length > 0 && operation.approved === undefined && operation.sandboxed === undefined)
            return undefined
          const ready = await PermissionExecution.ready(operation.checks)
          const manuallyApproved = (check: PermissionNext.Check) =>
            operation.approved?.some(
              (approved) => approved.permission === check.permission && approved.pattern === check.pattern,
            ) === true
          const forbidden =
            !PermissionLevel.allowsTool(mode, operation.tool) ||
            (operation.checks.length > 0 &&
              (!rules ||
                operation.checks.some((check) => {
                  const action = PermissionNext.evaluate(check.permission, check.pattern, rules).action
                  return action === "deny" || (!(ready && action === "allow") && !manuallyApproved(check))
                }))) ||
            (operation.sandboxed === false && !operation.checks.every(manuallyApproved))
          return forbidden ? { key, operation } : undefined
        }),
      )
    ).filter((item) => item !== undefined)
    // Rule providers can await I/O. A newer switch supersedes this decision before any cancellation is sent.
    if (!isCurrent()) return
    const pendingMessage = await Text.pick({
      zh: "新权限已生效，但仍有操作尚未确认停止。该对话暂不派发新操作。",
      en: "The new policy is active, but an operation has not confirmed cancellation. New work for this conversation is blocked.",
    })
    if (!isCurrent()) return
    for (const { operation } of affected) operation.stopping = pendingMessage
    for (const { operation } of affected)
      operation.controller.abort(new Error("Operation interrupted by session mode change"))
    for (const { key, operation } of affected)
      await PermissionNext.abortTool(operation.sessionID, key.slice(operation.sessionID.length + 1))
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
