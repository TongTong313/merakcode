import { Bus } from "../bus"
import { BusEvent } from "../bus/bus-event"
import { Config } from "../config/config"
import { Identifier } from "@merakcode/util/id"
import { Instance } from "../project/instance"
import { fn } from "../util/fn"
import { Log } from "@merakcode/log/logger"
import { Wildcard } from "../util/wildcard"
import os from "os"
import z from "zod"

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

  /** These requests only offer allow once / allow for this session / reject, never "always allow" */
  const SESSION_ONLY = new Set(["subagent", "workflow_run", "sandbox"])

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

  export const Request = z
    .object({
      id: Identifier.schema("permission"),
      sessionID: Identifier.schema("session"),
      /** Root session: subagent requests are shown there, and session grants are recorded against it */
      root: Identifier.schema("session").optional(),
      permission: z.string(),
      /** Items that need asking (command segments, file paths, domains, etc.) */
      patterns: z.string().array(),
      metadata: z.record(z.string(), z.any()),
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
  export const Reply = z.enum(["once", "session", "always", "reject"])
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
    resolve: () => void
    reject: (e: any) => void
  }

  const state = Instance.state(() => ({
    pending: {} as Record<string, Pending>,
    /** Rules "always allowed" in this process; also written to config, kept here so they apply before a reload */
    always: [] as Ruleset,
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
    const { Session } = await import("../session")
    return (await Session.get(root).catch(() => undefined))?.permission ?? []
  }

  /** Whether a grant covers this check: rules are the new grants; "always allow" rules count before a config reload */
  function granted(rules: Ruleset, check: Check) {
    return evaluate(check.permission, check.pattern, rules, state().always).action === "allow"
  }

  async function request(input: z.infer<typeof Ask>) {
    const s = state()
    const { ruleset, checks: given, ...request } = input
    const root = request.root ?? request.sessionID
    const checks =
      given ?? (request.patterns ?? []).map((pattern) => ({ permission: request.permission, pattern, grants: [] }))
    const asked: Check[] = []
    for (const check of checks) {
      const rule = evaluate(check.permission, check.pattern, ruleset)
      log.info("evaluated", { permission: check.permission, action: rule.action })
      if (rule.action === "deny")
        throw new DeniedError(ruleset.filter((r) => Wildcard.match(check.permission, r.permission)))
      if (rule.action === "ask" && !granted([], check)) asked.push(check)
    }
    if (asked.length === 0) return

    const id = input.id ?? Identifier.ascending("permission")
    const grants = asked
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
      always: asked.every((check) => !SESSION_ONLY.has(check.permission)),
    }
    /**
     * Register as pending before asking plugins: `reply` and `abortPending` both look up the pending table. A reply
     * can arrive while the hook runs (tests reply right after ask; cancelling calls abortPending); if registration came
     * later, that reply would be lost and ask would hang forever.
     */
    const settled = Promise.withResolvers<void>()
    // The reply can arrive before the caller holds this promise (rejected while the hook runs). Attach an observer so
    // the runtime does not report an unhandled rejection; the caller still gets the real result from the return below.
    settled.promise.catch(() => {})
    s.pending[id] = { info, root, checks: asked, resolve: settled.resolve, reject: settled.reject }

    /**
     * Plugin hook `permission.ask` (same name and shape as opencode 1.16.2) lets plugins change the decision before
     * the user is asked. `allow` lets the call through; `deny` throws DeniedError; `ask` (default) publishes
     * permission.asked and waits for the user. It only fires when the rules say ask: plugins cannot override a
     * configured allow/deny, otherwise they would be a back door around user config, read-only mode and the remote
     * lock. Imported dynamically to break the cycle plugin/index -> server -> routes -> this module.
     */
    const { Plugin } = await import("../plugin")
    const hook = await Plugin.trigger("permission.ask", info, { status: "ask" as "ask" | "deny" | "allow" })

    // Settled by reply/abort while the hook ran: pending was already removed, so return that result
    if (!s.pending[id]) return settled.promise

    if (hook.status === "allow") {
      delete s.pending[id]
      log.info("permission.ask hook allowed", { permission: request.permission })
      return
    }
    if (hook.status === "deny") {
      delete s.pending[id]
      log.info("permission.ask hook denied", { permission: request.permission })
      throw new DeniedError(ruleset.filter((r) => Wildcard.match(request.permission, r.permission)))
    }
    Bus.publish(Event.Asked, info)
    return settled.promise
  }

  export const ask = fn(Ask, (input) => request(input))

  /**
   * Pattern written into the granted rule: the chosen scope, else the check's first scope, else the check's own
   * pattern
   */
  function grantPattern(check: Check, scope?: Grant["scope"]) {
    return (check.grants.find((grant) => grant.scope === scope) ?? check.grants[0])?.pattern ?? check.pattern
  }

  /**
   * Writes "always allow" rules to the project config's permission section. A key that holds a plain string is first
   * expanded to { "*": value }.
   */
  async function persist(rules: Ruleset) {
    const saved = (await Config.loadProjectMerakCodeFile()).permission ?? {}
    const patch: Record<string, Record<string, Config.PermissionAction>> = {}
    for (const rule of rules) {
      const existing = saved[rule.permission]
      patch[rule.permission] ??= typeof existing === "string" ? { "*": existing } : {}
      patch[rule.permission]![rule.pattern] = "allow"
    }
    await Config.updateProjectMerakCode({ permission: patch }, { skipDispose: true })
  }

  export const ReplyInput = z.object({
    requestID: Identifier.schema("permission"),
    reply: Reply,
    /** Grant scope chosen for session / always */
    scope: Grant.shape.scope.optional(),
    /** Reason given with a rejection, passed to the agent verbatim */
    message: z.string().optional(),
  })
  export type ReplyInput = z.infer<typeof ReplyInput>

  export const reply = fn(ReplyInput, async (input) => {
    const s = state()
    const existing = s.pending[input.requestID]
    if (!existing) {
      log.warn("reply: request not found in pending, likely already resolved", {
        requestID: input.requestID,
      })
      return
    }
    delete s.pending[input.requestID]
    Bus.publish(Event.Replied, {
      sessionID: existing.info.sessionID,
      requestID: existing.info.id,
      reply: input.reply,
    })
    if (input.reply === "reject") {
      existing.reject(input.message ? new CorrectedError(input.message) : new RejectedError())
      return
    }
    if (input.reply === "once") {
      existing.resolve()
      return
    }

    const rules = existing.checks.map((check) => ({
      permission: check.permission,
      pattern: grantPattern(check, input.scope),
      action: "allow" as const,
    }))
    await grant(existing.root, rules)
    if (input.reply === "always" && existing.info.always) {
      s.always = mergeUnique(s.always, rules)
      await persist(rules).catch((error) => log.error("failed to persist always-allow rules", { error }))
    }
    log.info("granted", { root: existing.root, reply: input.reply, count: rules.length })
    existing.resolve()

    // Also release pending requests in the same root session that this grant fully covers
    for (const other of Object.values(s.pending)) {
      if (other.root !== existing.root) continue
      if (!other.checks.every((check) => granted(rules, check))) continue
      delete s.pending[other.info.id]
      Bus.publish(Event.Replied, { sessionID: other.info.sessionID, requestID: other.info.id, reply: input.reply })
      other.resolve()
    }
  })

  /**
   * Re-evaluates pending requests after the rules change (config edit, mode switch): requests whose checks are all
   * allowed now are released, the rest stay. rulesetOf returns the latest rule chain for the request's session, or
   * undefined to skip it.
   */
  export async function recheck(rulesetOf: (request: Request) => Promise<Ruleset | undefined>) {
    const s = state()
    for (const item of Object.values(s.pending)) {
      const ruleset = await rulesetOf(item.info).catch(() => undefined)
      if (!ruleset) continue
      const allowed = item.checks.every(
        (check) => evaluate(check.permission, check.pattern, ruleset).action === "allow" || granted([], check),
      )
      if (!allowed || !s.pending[item.info.id]) continue
      delete s.pending[item.info.id]
      log.info("released by recheck", { requestID: item.info.id })
      Bus.publish(Event.Replied, { sessionID: item.info.sessionID, requestID: item.info.id, reply: "once" })
      item.resolve()
    }
  }

  /** Records session grants in the root session's permission field without touching its updated time */
  async function grant(root: string, rules: Ruleset) {
    const { Session } = await import("../session")
    await Session.update(root, (draft) => void (draft.permission = mergeUnique(draft.permission ?? [], rules)), {
      touch: false,
    }).catch((error) => log.warn("failed to save session grant", { root, error }))
  }

  /** Session grants of the root session, listed and revoked from settings and the `/permissions` panel */
  export async function grants(root: string): Promise<Ruleset> {
    return (await sessionRules(root)).filter((rule) => rule.action === "allow")
  }

  export async function revoke(root: string, rule: Pick<Rule, "permission" | "pattern">) {
    const { Session } = await import("../session")
    await Session.update(
      root,
      (draft) =>
        void (draft.permission = (draft.permission ?? []).filter(
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
    const s = state()
    const pending = Object.values(s.pending).filter((item) => item.info.sessionID === sessionID)
    if (pending.length === 0) return
    log.info("abort pending", { sessionID, count: pending.length })
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
