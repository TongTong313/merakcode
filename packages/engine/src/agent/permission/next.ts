import { Bus } from "../../infra/bus/index"
import { BusEvent } from "../../infra/bus/bus-event"
import { Config } from "@merakcode/engine/agent/settings/index"
import { Identifier } from "@merakcode/util/id"
import { Instance } from "../../infra/project/instance"
import { fn } from "@merakcode/util/fn"
import { Log } from "@merakcode/log/logger"
import { Wildcard } from "../../infra/match/wildcard"
import os from "os"
import z from "zod"
import { SessionStore } from "../session/store"
import { PermissionLevel } from "./level"
import { NamedError } from "@merakcode/util/error"
import { Text } from "../prompt/text"

/**
 * Permission center: evaluates rules (allow / ask / deny), suspends until the user replies, and records grants.
 *
 * - One call can carry several checks (one per command segment); any deny rejects the whole call, and all checks
 *   that need asking are combined into one request
 * - "This session" grants are stored in the root session's permission field (persisted with the session, visible
 *   across processes); the rule chain places them at the user-rule layer, shared by subagents. "Always allow" is
 *   written to the project .merakcode config
 * - Grants only answer "ask": a deny from the rule chain (read-only mode, agent limits, remote lock, user denies)
 *   cannot be overridden by a grant
 */
export namespace PermissionNext {
  const log = Log.create({ service: "permission" })

  /**
   * Internal protocol permission keys that are ignored in user config.
   * Plan switching, doom loop detection and the todowrite protocol are managed by agent profiles and runtime rules;
   * todowrite is always allowed once it is in the tool pool, so users cannot set its permission.
   */
  export const INTERNAL_PERMISSION_KEYS = new Set<string>([
    "plan_enter",
    "plan_exit",
    "doom_loop",
    "todowrite",
    "delegate",
  ])

  function expand(pattern: string): string {
    if (pattern.startsWith("~/")) return os.homedir() + pattern.slice(1)
    if (pattern === "~") return os.homedir()
    if (pattern.startsWith("$HOME/")) return os.homedir() + pattern.slice(5)
    if (pattern.startsWith("$HOME")) return os.homedir() + pattern.slice(5)
    return pattern
  }

  export const Action = z.enum(["allow", "deny", "ask"]).meta({
    ref: "PermissionAction",
  })
  export type Action = z.infer<typeof Action>

  export const Rule = z
    .object({
      permission: z.string(),
      pattern: z.string(),
      action: Action,
    })
    .meta({
      ref: "PermissionRule",
    })
  export type Rule = z.infer<typeof Rule>

  export const Ruleset = Rule.array().meta({
    ref: "PermissionRuleset",
  })
  export type Ruleset = z.infer<typeof Ruleset>

  export function fromConfig(permission: Config.Permission) {
    const ruleset: Ruleset = []
    for (const [key, value] of Object.entries(permission)) {
      if (typeof value === "string") {
        ruleset.push({
          permission: key,
          action: value,
          pattern: "*",
        })
        continue
      }
      ruleset.push(
        ...Object.entries(value).map(([pattern, action]) => ({ permission: key, pattern: expand(pattern), action })),
      )
    }
    return ruleset
  }

  /** Rules from user config: internal protocol keys and the deprecated task key are dropped, the rest kept as is */
  export function fromUserConfig(permission: Config.Permission): Ruleset {
    const kept = Object.fromEntries(
      Object.entries(permission).filter(([key]) => {
        if (key === "task") log.warn("ignored deprecated permission key task (use subagent)", { key })
        else if (INTERNAL_PERMISSION_KEYS.has(key))
          log.warn("ignored internal permission key from user config", { key })
        else return true
        return false
      }),
    )
    return fromConfig(kept)
  }

  export function merge(...rulesets: Ruleset[]): Ruleset {
    return rulesets.flat()
  }

  export function mergeUnique(...rulesets: Ruleset[]): Ruleset {
    const seen = new Set<string>()
    const result: Ruleset = []
    for (const rule of merge(...rulesets)) {
      const key = `${rule.permission}\0${rule.pattern}\0${rule.action}`
      if (seen.has(key)) continue
      seen.add(key)
      result.push(rule)
    }
    return result
  }

  /**
   * Forces subagent: deny at the end of a child session's rules. evaluate uses findLast, so appending it overrides
   * any user allow.
   */
  export function appendForbidNestedSubagentRule(): Ruleset {
    return fromConfig({ subagent: "deny" })
  }

  /**
   * Grant scope: options in the approval bar such as trusting this file, directory, command prefix or domain for the
   * session
   */
  export const Grant = z
    .object({
      scope: z.enum(["file", "directory", "prefix", "agent", "tool", "domain"]),
      /** Pattern written into the rule */
      pattern: z.string(),
    })
    .meta({ ref: "PermissionGrant" })
  export type Grant = z.infer<typeof Grant>

  /** One check: evaluates pattern under the permission key; grants are the scopes the user may choose */
  export const Check = z.object({
    permission: z.string(),
    pattern: z.string(),
    grants: Grant.array(),
  })
  export type Check = z.infer<typeof Check>

  /** Ephemeral approval receipt, bound to one call and its execution conditions. */
  export type Admission = {
    root: string
    permissionLevel: PermissionLevel.Value
    permissionRevision: number
    sandboxReady: boolean
    approved: Check[]
    rulesetOf?: () => Promise<Ruleset>
  }

  export const Request = z
    .object({
      id: Identifier.schema("permission"),
      sessionID: Identifier.schema("session"),
      executionID: z.string().optional(),
      /** Root session: subagent requests are shown there, and session grants are recorded against it */
      root: Identifier.schema("session").optional(),
      permission: z.string(),
      /** Items that need asking (command segments, file paths, domains, etc.) */
      patterns: z.string().array(),
      metadata: z.record(z.string(), z.any()),
      sandboxReady: z.boolean().optional(),
      permissionLevel: PermissionLevel.Schema.optional(),
      permissionRevision: z.number().int().nonnegative().optional(),
      decisionRevision: z.number().int().nonnegative().optional(),
      /** Grant scopes the user may choose */
      grants: Grant.array().optional(),
      /** Whether "always allow" is offered */
      always: z.boolean().optional(),
      /** Origin of a request sent by a subagent */
      source: z
        .object({
          sessionID: Identifier.schema("session"),
          agent: z.string(),
          title: z.string().optional(),
        })
        .optional(),
      tool: z
        .object({
          messageID: z.string(),
          callID: z.string(),
        })
        .optional(),
    })
    .meta({
      ref: "PermissionRequest",
    })

  export type Request = z.infer<typeof Request>

  /** once: allow this call; session: allow for this session; always: write to project config; reject: deny */
  export const Reply = z.enum(["once", "session", "reject"])
  export type Reply = z.infer<typeof Reply>

  export const Event = {
    Asked: BusEvent.define("permission.asked", Request),
    Replied: BusEvent.define(
      "permission.replied",
      z.object({
        sessionID: z.string(),
        requestID: z.string(),
        reply: Reply,
      }),
    ),
  }

  type Pending = {
    info: Request
    root: string
    checks: Check[]
    asked: Check[]
    replying?: boolean
    resolve: (manual?: boolean) => void
    reject: (e: any) => void
  }

  const state = Instance.state(() => ({
    pending: {} as Record<string, Pending>,
  }))

  const Ask = Request.partial({ id: true, patterns: true })
    .omit({ grants: true, always: true })
    .extend({ ruleset: Ruleset, checks: Check.array().optional() })
  export type AskInput = z.input<typeof Ask>

  /**
   * Rules recorded on the root session (where session grants live). Imported dynamically to break the cycle: session
   * imports this module statically.
   */
  async function sessionRules(root: string): Promise<Ruleset> {
    const { Session } = await import("../session/index")
    return (await Session.get(root).catch(() => undefined))?.permissionGrants ?? []
  }

  /** Whether a grant covers this check: rules are the new grants; "always allow" rules count before a config reload */
  function granted(rules: Ruleset, check: Check) {
    return evaluate(check.permission, check.pattern, rules).action === "allow"
  }

  async function request(input: z.infer<typeof Ask>) {
    const s = state()
    const { ruleset, checks: given, ...request } = input
    const root = request.root ?? request.sessionID
    const checks =
      given ?? (request.patterns ?? []).map((pattern) => ({ permission: request.permission, pattern, grants: [] }))
    const asked: Check[] = []
    const approved: Check[] = []
    for (const check of checks) {
      const rule = evaluate(check.permission, check.pattern, ruleset)
      log.info("evaluated", { permission: check.permission, action: rule.action })
      if (rule.action === "deny")
        throw new DeniedError(ruleset.filter((r) => Wildcard.match(check.permission, r.permission)))
      if (rule.action !== "ask") continue
      if (request.sandboxReady !== false && granted(SessionStore.find(root)?.permissionGrants ?? [], check))
        approved.push(check)
      else asked.push(check)
    }
    const receipt = (info: Pick<Request, "sandboxReady" | "permissionLevel">, manual = false): Admission => ({
      root,
      permissionLevel: info.permissionLevel ?? PermissionLevel.DEFAULT,
      permissionRevision: SessionStore.find(root)?.permissionRevision ?? 0,
      sandboxReady: info.sandboxReady === true,
      approved: manual ? [...approved, ...asked] : approved,
    })
    if (asked.length === 0) return receipt(request)

    const id = input.id ?? Identifier.ascending("permission")
    const grants = (request.sandboxReady === false ? [] : asked)
      .flatMap((check) => check.grants)
      .filter(
        (grant, index, all) =>
          all.findIndex((item) => item.scope === grant.scope && item.pattern === grant.pattern) === index,
      )
    const info: Request = {
      ...request,
      id,
      root,
      patterns: asked.map((check) => check.pattern),
      grants,
      always: false,
      permissionRevision: SessionStore.find(root)?.permissionRevision ?? 0,
      decisionRevision: 0,
    }
    /**
     * Register as pending before asking plugins: `reply` and `abortPending` both look up the pending table. A reply
     * can arrive while the hook runs (tests reply right after ask; cancelling calls abortPending); if registration came
     * later, that reply would be lost and ask would hang forever.
     */
    const settled = Promise.withResolvers<Admission>()
    // The reply can arrive before the caller holds this promise (rejected while the hook runs). Attach an observer so
    // the runtime does not report an unhandled rejection; the caller still gets the real result from the return below.
    settled.promise.catch(() => {})
    s.pending[id] = {
      info,
      root,
      checks,
      asked,
      resolve: (manual) => settled.resolve(receipt(info, manual)),
      reject: settled.reject,
    }

    /**
     * Plugin hook `permission.ask` (same name and shape as opencode 1.16.2) lets plugins change the decision before
     * the user is asked. `allow` lets the call through; `deny` throws DeniedError; `ask` (default) publishes
     * permission.asked and waits for the user. It only fires when the rules say ask: plugins cannot override a
     * configured allow/deny, otherwise they would be a back door around user config, read-only mode and the remote
     * lock. Imported dynamically to break the cycle plugin/index -> server -> routes -> this module.
     */
    const { Plugin } = await import("../plugin/index")
    const hook = await Plugin.trigger("permission.ask", info, { status: "ask" as "ask" | "deny" | "allow" })

    // Settled by reply/abort while the hook ran: pending was already removed, so return that result
    if (!s.pending[id]) return settled.promise

    if (hook.status === "deny") {
      delete s.pending[id]
      log.info("permission.ask hook denied", { permission: request.permission })
      throw new DeniedError(ruleset.filter((r) => Wildcard.match(request.permission, r.permission)))
    }
    Bus.publish(Event.Asked, info)
    return settled.promise
  }

  export const ask = fn(Ask, async ({ ruleset, ...input }) => {
    await askCurrent(input, async () => ruleset)
  })

  async function executionPolicy(
    input: Pick<AskInput, "sessionID" | "root" | "executionID" | "permission" | "metadata" | "tool">,
    ruleset: Ruleset,
    checks: Check[],
  ) {
    const { TaskScope } = await import("./scope")
    await TaskScope.assert(input.sessionID, checks, input.tool?.messageID)
    const { PermissionExecution } = await import("./execution")
    const permissionLevel = SessionStore.find(input.root ?? input.sessionID)?.permissionLevel ?? PermissionLevel.DEFAULT
    const sandboxReady =
      !input.executionID &&
      !input.metadata.pluginTool &&
      input.permission !== "mcp" &&
      input.permission !== "lsp" &&
      !input.metadata.unsandboxed &&
      (await PermissionExecution.ready(checks))
    return {
      permissionLevel,
      sandboxReady,
      ruleset:
        permissionLevel === "fullTakeover" || sandboxReady
          ? ruleset
          : ruleset.map((rule) => (rule.action === "allow" ? { ...rule, action: "ask" as const } : rule)),
    }
  }

  /** Resolve policy and admit the request in the same mode revision, before any asynchronous plugin hook. */
  export async function askCurrent(
    input: Omit<AskInput, "ruleset">,
    rulesetOf: () => Promise<Ruleset>,
    abort?: AbortSignal,
  ) {
    const root = input.root ?? input.sessionID
    for (;;) {
      abort?.throwIfAborted()
      const before = SessionStore.find(root)
      const policy = await executionPolicy(
        input,
        await rulesetOf(),
        input.checks ??
          (input.patterns ?? []).map((pattern) => ({ permission: input.permission, pattern, grants: [] })),
      )
      abort?.throwIfAborted()
      const current = SessionStore.find(root)
      if (
        before?.permissionRevision !== current?.permissionRevision ||
        before?.permissionLevel !== current?.permissionLevel
      )
        continue
      const admission = await request(Ask.parse({ ...input, ...policy }))
      return { ...admission, rulesetOf }
    }
  }

  /** Recheck the receipt immediately before the authorized side effect. */
  export async function isCurrent(
    admission: Admission,
    input: Omit<AskInput, "ruleset" | "sessionID"> & { sessionID?: string },
  ) {
    const rules = (await admission.rulesetOf?.()) ?? []
    const checks =
      input.checks ?? (input.patterns ?? []).map((pattern) => ({ permission: input.permission, pattern, grants: [] }))
    if (checks.some((check) => evaluate(check.permission, check.pattern, rules).action === "deny"))
      throw new DeniedError(rules)
    const policy = await executionPolicy(
      { ...input, sessionID: input.sessionID ?? admission.root, root: admission.root },
      rules,
      checks,
    )
    const current = SessionStore.find(admission.root)
    return (
      admission.sandboxReady === policy.sandboxReady &&
      admission.permissionRevision === (current?.permissionRevision ?? 0) &&
      admission.permissionLevel === (current?.permissionLevel ?? PermissionLevel.DEFAULT)
    )
  }

  /**
   * Pattern written into the granted rule: the chosen scope, else the check's first scope, else the check's own
   * pattern
   */
  function grantPattern(check: Check, scope?: Grant["scope"]) {
    return (check.grants.find((grant) => grant.scope === scope) ?? check.grants[0])?.pattern ?? check.pattern
  }

  export const ReplyInput = z.object({
    requestID: Identifier.schema("permission"),
    reply: Reply,
    decisionRevision: z.number().int().nonnegative().optional(),
    /** Grant scope chosen for session / always */
    scope: Grant.shape.scope.optional(),
    /** Reason given with a rejection, passed to the agent verbatim */
    message: z.string().optional(),
  })
  export type ReplyInput = z.infer<typeof ReplyInput>
  export const GrantUnavailableError = NamedError.create(
    "PermissionGrantUnavailableError",
    z.object({ message: z.string() }),
  )
  export const DecisionConflictError = NamedError.create(
    "PermissionDecisionConflictError",
    z.object({ message: z.string() }),
  )

  async function recheckCurrent(root: string) {
    const { PermissionFlush } = await import("./flush")
    for (;;) {
      const before = SessionStore.find(root)
      await PermissionFlush.run()
      const current = SessionStore.find(root)
      if (
        before?.permissionRevision === current?.permissionRevision &&
        before?.permissionLevel === current?.permissionLevel
      )
        return current
    }
  }

  export const reply = fn(ReplyInput, async (input) => {
    const s = state()
    // A reply may reach us before the mode-switch flush finishes. Recheck the whole operation first.
    const pending = s.pending[input.requestID]
    if (pending && input.reply !== "reject") {
      for (;;) {
        const confirmed = await recheckCurrent(pending.root)
        const current = SessionStore.find(pending.root)
        if (
          confirmed?.permissionRevision === current?.permissionRevision &&
          confirmed?.permissionLevel === current?.permissionLevel
        )
          break
      }
    }
    const existing = s.pending[input.requestID]
    if (!existing) {
      log.warn("reply: request not found in pending, likely already resolved", {
        requestID: input.requestID,
      })
      return
    }
    if (existing.replying) return
    const finish = () => {
      delete s.pending[input.requestID]
      Bus.publish(Event.Replied, {
        sessionID: existing.info.sessionID,
        requestID: existing.info.id,
        reply: input.reply,
      })
    }
    if (input.reply === "reject") {
      finish()
      existing.reject(input.message ? new CorrectedError(input.message) : new RejectedError())
      return
    }
    if ((input.decisionRevision ?? 0) !== (existing.info.decisionRevision ?? 0))
      throw new DecisionConflictError({
        message: await Text.pick({
          zh: "审批条件已改变，请核对当前请求后重新选择。",
          en: "Approval conditions changed. Review the current request before deciding again.",
        }),
      })
    if (input.reply === "once") {
      finish()
      existing.resolve(true)
      return
    }

    if (
      existing.info.sandboxReady === false ||
      !existing.asked.every((check) =>
        check.grants.some((grant) => input.scope === undefined || grant.scope === input.scope),
      )
    )
      throw new GrantUnavailableError({
        message: await Text.pick({
          zh: "当前操作未隔离，只能允许这一次或拒绝。",
          en: "This operation is not isolated. Allow it once or reject it.",
        }),
      })
    existing.replying = true
    const rules = existing.asked.map((check) => ({
      permission: check.permission,
      pattern: grantPattern(check, input.scope),
      action: "allow" as const,
    }))
    await grant(existing.root, rules)
    log.info("granted", { root: existing.root, reply: input.reply, count: rules.length })
    // Keep the operation pending throughout grant persistence, so a concurrent tightening can still reject it.
    for (;;) {
      const confirmed = await recheckCurrent(existing.root)
      const current = SessionStore.find(existing.root)
      if (
        confirmed?.permissionRevision === current?.permissionRevision &&
        confirmed?.permissionLevel === current?.permissionLevel
      )
        break
    }
    if (!s.pending[input.requestID]) return
    finish()
    existing.resolve(true)

    // Also release pending requests in the same root session that this grant fully covers
    for (const other of Object.values(s.pending)) {
      if (other.root !== existing.root || other.info.sandboxReady === false) continue
      if (!other.asked.every((check) => granted(rules, check))) continue
      delete s.pending[other.info.id]
      Bus.publish(Event.Replied, { sessionID: other.info.sessionID, requestID: other.info.id, reply: input.reply })
      other.resolve(true)
    }
  })

  /**
   * Re-evaluates pending requests after the rules change (config edit, mode switch): requests whose checks are all
   * allowed now are released, the rest stay. rulesetOf returns the latest rule chain for the request's session, or
   * undefined to skip it.
   */
  export async function recheck(rulesetOf: (request: Request, checks: Check[]) => Promise<Ruleset | undefined>) {
    const s = state()
    for (const item of Object.values(s.pending)) {
      const before = SessionStore.find(item.root)
      const proposed = await rulesetOf(item.info, item.checks).catch(() => undefined)
      const policy = proposed
        ? await executionPolicy(item.info, proposed, item.checks).catch((error) => {
            if (error?.name !== "TaskScopeDeniedError") throw error
            if (!s.pending[item.info.id]) return
            delete s.pending[item.info.id]
            Bus.publish(Event.Replied, { sessionID: item.info.sessionID, requestID: item.info.id, reply: "reject" })
            item.reject(error)
          })
        : undefined
      const ruleset = policy?.ruleset
      const current = SessionStore.find(item.root)
      // Do not apply an old decision after a newer mode switch has already rechecked this request.
      if (
        before?.permissionRevision !== current?.permissionRevision ||
        before?.permissionLevel !== current?.permissionLevel
      )
        continue
      if (!ruleset || !policy || !s.pending[item.info.id]) continue
      const changed =
        item.info.sandboxReady !== policy.sandboxReady ||
        item.info.permissionLevel !== policy.permissionLevel ||
        (item.info.permissionRevision ?? 0) !== (current?.permissionRevision ?? 0)
      if (changed) item.info.decisionRevision = (item.info.decisionRevision ?? 0) + 1
      item.info.permissionRevision = current?.permissionRevision ?? 0
      item.info.sandboxReady = policy.sandboxReady
      item.info.permissionLevel = policy.permissionLevel
      item.info.grants = policy.sandboxReady ? item.asked.flatMap((check) => check.grants) : []
      const allowed = item.checks.every(
        (check) =>
          evaluate(check.permission, check.pattern, ruleset).action === "allow" ||
          (item.info.sandboxReady !== false && granted(SessionStore.find(item.root)?.permissionGrants ?? [], check)),
      )
      if (
        item.checks.some((check) => evaluate(check.permission, check.pattern, ruleset).action === "deny") &&
        s.pending[item.info.id]
      ) {
        delete s.pending[item.info.id]
        Bus.publish(Event.Replied, { sessionID: item.info.sessionID, requestID: item.info.id, reply: "reject" })
        item.reject(new DeniedError(ruleset))
        continue
      }
      if (!s.pending[item.info.id]) continue
      if (!allowed) {
        if (changed) Bus.publish(Event.Asked, item.info)
        continue
      }
      delete s.pending[item.info.id]
      log.info("released by recheck", { requestID: item.info.id })
      Bus.publish(Event.Replied, { sessionID: item.info.sessionID, requestID: item.info.id, reply: "once" })
      item.resolve()
    }
  }

  /** Records session grants in the root session's permission field without touching its updated time */
  async function grant(root: string, rules: Ruleset) {
    const { Session } = await import("../session/index")
    await Session.update(
      root,
      (draft) => void (draft.permissionGrants = mergeUnique(draft.permissionGrants ?? [], rules)),
      {
        touch: false,
      },
    ).catch((error) => log.warn("failed to save session grant", { root, error }))
  }

  /** Session grants of the root session, listed and revoked from settings and the `/permissions` panel */
  export async function grants(root: string): Promise<Ruleset> {
    return (await sessionRules(root)).filter((rule) => rule.action === "allow")
  }

  export async function revoke(root: string, rule: Pick<Rule, "permission" | "pattern">) {
    const { Session } = await import("../session/index")
    await Session.update(
      root,
      (draft) =>
        void (draft.permissionGrants = (draft.permissionGrants ?? []).filter(
          (item) => item.action !== "allow" || item.permission !== rule.permission || item.pattern !== rule.pattern,
        )),
      { touch: false },
    )
  }

  /** Normalizes non-bash path patterns: forward slashes, and on Windows a lowercase drive so c: matches C: */
  export function normalizePath(pattern: string): string {
    return normalizePathPattern(pattern)
  }

  function normalizePathPattern(pattern: string): string {
    const slashed = pattern.replace(/\\/g, "/")
    if (process.platform !== "win32") return slashed
    return slashed.replace(/^([A-Za-z]):/, (_, drive: string) => `${drive.toLowerCase()}:`)
  }

  /** Commands match verbatim (a backslash is an escape, not a path separator); everything else is normalized */
  function raw(permission: string) {
    return permission === "bash" || permission.startsWith("bash_")
  }

  /** Returns the last matching rule; ask when nothing matches */
  export function evaluate(permission: string, pattern: string, ...rulesets: Ruleset[]): Rule {
    const keep = raw(permission)
    const normalized = keep ? pattern : normalizePathPattern(pattern)
    const match = merge(...rulesets).findLast(
      (rule) =>
        Wildcard.match(permission, rule.permission) &&
        Wildcard.match(normalized, keep ? rule.pattern : normalizePathPattern(rule.pattern)),
    )
    return match ?? { action: "ask", permission, pattern: "*" }
  }

  /**
   * Clears the session's pending requests when the conversation stops: publishes permission.replied and rejects with
   * AbortedError. The approval bar closes on the replied event; without it the card stays after the session stops.
   */
  export async function abortPending(sessionID: string) {
    return abortMatching((item) => item.info.sessionID === sessionID)
  }

  export async function abortExecution(executionID: string) {
    return abortMatching((item) => item.info.executionID === executionID)
  }

  export async function abortTool(sessionID: string, callID: string) {
    return abortMatching((item) => item.info.sessionID === sessionID && item.info.tool?.callID === callID)
  }

  async function abortMatching(matches: (item: Pending) => boolean) {
    const s = state()
    const pending = Object.values(s.pending).filter(matches)
    if (pending.length === 0) return
    log.info("abort pending", { count: pending.length })
    for (const item of pending) {
      delete s.pending[item.info.id]
      Bus.publish(Event.Replied, {
        sessionID: item.info.sessionID,
        requestID: item.info.id,
        reply: "reject",
      })
      item.reject(new AbortedError())
    }
  }

  /** User rejected without message - halts execution */
  export class RejectedError extends Error {
    constructor() {
      super(`The user rejected permission to use this specific tool call.`)
    }
  }

  /** session.abort interrupted a blocking permission request; the approval bar should close */
  export class AbortedError extends Error {
    constructor() {
      super("The permission request was aborted")
    }
  }

  /** User rejected with message - continues with guidance */
  export class CorrectedError extends Error {
    constructor(message: string) {
      super(`The user rejected permission to use this specific tool call with the following feedback: ${message}`)
    }
  }

  /** Auto-rejected by config rule - halts execution */
  export class DeniedError extends Error {
    constructor(public readonly ruleset: Ruleset) {
      super(
        `The user has specified a rule which prevents you from using this specific tool call. Here are some of the relevant rules ${JSON.stringify(ruleset)}`,
      )
    }
  }

  export async function list() {
    return Object.values(state().pending).map((x) => x.info)
  }
}
