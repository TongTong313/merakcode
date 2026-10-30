import { Config } from "@merakcode/engine/agent/settings/index"
import { MCP } from "./"
import { Lock } from "@merakcode/engine/infra/concurrency/lock"
import { McpConfigWriter } from "./config-writer"
import { McpManagementContract } from "./management-contract"
import { isDeepStrictEqual } from "node:util"

export namespace McpManagement {
  const transaction = "mcp-management:transaction"
  export type Server = McpManagementContract.Server
  export type Snapshot = McpManagementContract.Snapshot
  export type Command = McpManagementContract.Command
  export type ErrorInfo = McpManagementContract.ErrorInfo
  export type Result = McpManagementContract.Result

  type Entry = McpConfigWriter.Entry

  interface Setting {
    scope: McpConfigWriter.Scope
    value: Entry
  }

  function configured(entry: Entry | undefined): entry is Config.Mcp {
    return !!entry && "type" in entry
  }

  function materialize(global: Entry | undefined, project: Entry | undefined, merged: Entry | undefined) {
    if (configured(project)) return project
    if (project && configured(global)) return { ...global, enabled: project.enabled }
    if (configured(merged)) return merged
    if (configured(global)) return global
  }

  function overlay(config: Config.Mcp, project: Entry | undefined) {
    return project && !configured(project) ? { ...config, enabled: project.enabled } : config
  }

  function runtimeStatus(status: MCP.Status | undefined): MCP.Status {
    if (!status) return { status: "disabled" }
    const { scope: _, ...runtime } = status
    return runtime
  }

  /** An edit without transport keeps the one from the config on disk, so an explicit transport is not lost */
  function preserveTransport(config: Config.Mcp, current: Config.Mcp) {
    if (config.type !== "remote" || current.type !== "remote") return config
    if (config.transport) return config
    if (!current.transport) return config
    return Config.Mcp.parse({ ...config, transport: current.transport })
  }

  function connectionConfig(config: Config.Mcp) {
    const { deferred: _, ...rest } = config
    const value = {
      ...rest,
      enabled: config.enabled !== false,
      ...(config.type === "remote"
        ? { headers: Object.keys(config.headers ?? {}).length ? config.headers : undefined }
        : { environment: Object.keys(config.environment ?? {}).length ? config.environment : undefined }),
    }
    return Object.fromEntries(Object.entries(value).filter(([, value]) => value !== undefined))
  }

  async function changeDeferred(
    command: Extract<Command, { type: "replace" }>,
    current: Server,
    before: Snapshot,
  ): Promise<Result | undefined> {
    const config = preserveTransport(command.config, current.config)
    if (!isDeepStrictEqual(connectionConfig(config), connectionConfig(current.config))) return
    const raw = await entries(command.name)
    if (!configured(raw.global) || configured(raw.project)) return shadow(command.name, current.scope, before)
    const deferred = config.deferred === true
    if (deferred === (current.config.deferred === true)) return { ok: true, snapshot: before }
    const saved = await attempt(() => McpConfigWriter.commit("global", [{ name: command.name, deferred }]))
    if (!saved.ok) {
      return {
        ok: false,
        error: {
          code: "config_write_failed",
          message: saved.error,
          facts: [{ stage: "config", action: "replace", ok: false, message: saved.error }],
        },
        snapshot: before,
      }
    }
    return { ok: true, snapshot: await snapshot(false) }
  }

  async function entries(name: string) {
    const [global, project] = await Promise.all([Config.getGlobal(), Config.loadProjectMerakCodeFile()])
    return { global: global.mcp?.[name], project: project.mcp?.[name] }
  }

  async function toggle(name: string, current: Server, enabled: boolean): Promise<Setting | undefined> {
    const project = (await entries(name)).project
    // Write to the layer that holds the server, like replace/rename; not always a project override
    if (configured(project)) return { scope: "project" as const, value: { ...current.config, enabled } satisfies Entry }
    // Legacy project `{ enabled }` overlay: keep updating it so the materialized config matches what is on disk
    if (project) return { scope: "project" as const, value: { enabled } satisfies Entry }
    return { scope: "global" as const, value: { ...current.config, enabled } satisfies Entry }
  }

  function message(error: unknown) {
    return error instanceof globalThis.Error ? error.message : String(error)
  }

  function shadow(name: string, scope: "project" | "global", before: Snapshot): Result {
    return {
      ok: false,
      error: {
        code: "shadowed",
        message: `MCP server ${name} is shadowed by ${scope} configuration`,
        facts: [],
      },
      snapshot: before,
    }
  }

  async function enable(name: string, current: Server, before: Snapshot, setting: Setting): Promise<Result> {
    const started = await reconnect(name)
    if (!started.ok) {
      const compensation = await stop(name)
      return {
        ok: false,
        error: {
          code: compensation.ok ? "runtime_connect_failed" : "compensation_failed",
          message: started.error,
          facts: [
            {
              stage: "runtime",
              action: "connect",
              ok: false,
              message: started.error,
            },
            {
              stage: "compensation",
              action: "disconnect",
              ok: compensation.ok,
              ...(!compensation.ok ? { message: compensation.error } : {}),
            },
          ],
        },
        snapshot: await snapshot(),
      }
    }

    const { scope, value } = setting
    const saved = await attempt(() => McpConfigWriter.commit(scope, [{ name, value }]))
    if (!saved.ok) {
      const compensation = await stop(name)
      return {
        ok: false,
        error: {
          code: compensation.ok ? "config_write_failed" : "compensation_failed",
          message: saved.error,
          facts: [
            { stage: "runtime", action: "connect", ok: true },
            { stage: "config", action: "set_enabled", ok: false, message: saved.error },
            {
              stage: "compensation",
              action: "disconnect",
              ok: compensation.ok,
              ...(!compensation.ok ? { message: compensation.error } : {}),
            },
          ],
        },
        snapshot: before,
      }
    }

    return { ok: true, snapshot: await snapshot() }
  }

  async function reconnect(name: string) {
    const started = await MCP.connect(name).then(
      () => ({ ok: true as const }),
      (error) => ({ ok: false as const, error: message(error) }),
    )
    if (!started.ok) return started
    return MCP.status().then(
      (status) => {
        const current = status[name]
        if (current?.status === "connected") return { ok: true as const }
        return {
          ok: false as const,
          error: current?.status === "failed" ? current.error : `MCP server ${name} did not connect`,
        }
      },
      (error) => ({ ok: false as const, error: message(error) }),
    )
  }

  async function stop(name: string) {
    return MCP.disconnectResult(name).catch((error) => ({ ok: false as const, error: message(error) }))
  }

  async function disable(name: string, current: Server, before: Snapshot, setting: Setting): Promise<Result> {
    const stopped = await stop(name)
    if (!stopped.ok) {
      const compensation = await reconnect(name)
      return {
        ok: false,
        error: {
          code: compensation.ok ? "runtime_disconnect_failed" : "compensation_failed",
          message: stopped.error,
          facts: [
            { stage: "runtime", action: "disconnect", ok: false, message: stopped.error },
            {
              stage: "compensation",
              action: "connect",
              ok: compensation.ok,
              ...(!compensation.ok ? { message: compensation.error } : {}),
            },
          ],
        },
        snapshot: await snapshot(),
      }
    }

    const { scope, value } = setting
    const saved = await attempt(() => McpConfigWriter.commit(scope, [{ name, value }]))
    if (!saved.ok) {
      const compensation = await restore(name, current)
      const action = current.status.status === "disabled" ? "disconnect" : "connect"
      return {
        ok: false,
        error: {
          code: compensation.ok ? "config_write_failed" : "compensation_failed",
          message: saved.error,
          facts: [
            { stage: "runtime", action: "disconnect", ok: true },
            { stage: "config", action: "set_enabled", ok: false, message: saved.error },
            {
              stage: "compensation",
              action,
              ok: compensation.ok,
              ...(!compensation.ok ? { message: compensation.error } : {}),
            },
          ],
        },
        snapshot: await snapshot(),
      }
    }

    return { ok: true, snapshot: await snapshot() }
  }

  type Fact = ErrorInfo["facts"][number]

  async function attempt(fn: () => Promise<void>) {
    return fn().then(
      () => ({ ok: true as const }),
      (error) => ({ ok: false as const, error: message(error) }),
    )
  }

  async function failed(code: ErrorInfo["code"], detail: string, facts: Fact[], before: Snapshot): Promise<Result> {
    const current = await snapshot().catch(() => before)
    return { ok: false, error: { code, message: detail, facts }, snapshot: current }
  }

  async function restore(name: string, current: Server) {
    if (current.status.status === "disabled") return stop(name)
    return reconnect(name)
  }

  async function add(command: Extract<Command, { type: "add" }>, before: Snapshot): Promise<Result> {
    const config = overlay(command.config, (await entries(command.name)).project)
    const saved = await attempt(() => McpConfigWriter.commit("global", [{ name: command.name, value: command.config }]))
    if (!saved.ok) {
      return failed(
        "config_write_failed",
        saved.error,
        [{ stage: "config", action: "add", ok: false, message: saved.error }],
        before,
      )
    }
    if (config.enabled === false) return { ok: true, snapshot: await snapshot() }

    const started = await reconnect(command.name)
    if (started.ok) return { ok: true, snapshot: await snapshot() }

    const rollback = await attempt(() => McpConfigWriter.commit("global", [{ name: command.name, value: undefined }]))
    const stopped = await stop(command.name)
    const ok = rollback.ok && stopped.ok
    return failed(
      ok ? "runtime_connect_failed" : "compensation_failed",
      started.error,
      [
        { stage: "config", action: "add", ok: true },
        { stage: "runtime", action: "connect", ok: false, message: started.error },
        {
          stage: "compensation",
          action: "remove_config",
          ok: rollback.ok,
          ...(!rollback.ok ? { message: rollback.error } : {}),
        },
        {
          stage: "compensation",
          action: "disconnect",
          ok: stopped.ok,
          ...(!stopped.ok ? { message: stopped.error } : {}),
        },
      ],
      before,
    )
  }

  async function replace(
    command: Extract<Command, { type: "replace" }>,
    current: Server,
    before: Snapshot,
    scope: "project" | "global",
    config: Config.Mcp,
    previous: Config.Mcp,
    effective: Config.Mcp,
  ): Promise<Result> {
    const saved = await attempt(() => McpConfigWriter.commit(scope, [{ name: command.name, value: config }]))
    if (!saved.ok) {
      return failed(
        "config_write_failed",
        saved.error,
        [{ stage: "config", action: "replace", ok: false, message: saved.error }],
        before,
      )
    }

    const action = effective.enabled === false ? "disconnect" : "connect"
    const changed = effective.enabled === false ? await stop(command.name) : await reconnect(command.name)
    if (changed.ok) return { ok: true, snapshot: await snapshot() }

    const rollback = await attempt(() => McpConfigWriter.commit(scope, [{ name: command.name, value: previous }]))
    const restored = await restore(command.name, current)
    const ok = rollback.ok && restored.ok
    return failed(
      ok ? (action === "connect" ? "runtime_connect_failed" : "runtime_disconnect_failed") : "compensation_failed",
      changed.error,
      [
        { stage: "config", action: "replace", ok: true },
        { stage: "runtime", action, ok: false, message: changed.error },
        {
          stage: "compensation",
          action: "restore_config",
          ok: rollback.ok,
          ...(!rollback.ok ? { message: rollback.error } : {}),
        },
        {
          stage: "compensation",
          action: "restore_runtime",
          ok: restored.ok,
          ...(!restored.ok ? { message: restored.error } : {}),
        },
      ],
      before,
    )
  }

  async function renameServer(
    command: Extract<Command, { type: "rename" }>,
    current: Server,
    before: Snapshot,
    scope: "project" | "global",
    config: Config.Mcp,
    previous: Config.Mcp,
  ): Promise<Result> {
    const edits = [
      { name: command.name, value: undefined },
      { name: command.newName, value: config },
    ]
    const saved = await attempt(() => McpConfigWriter.commit(scope, edits))
    if (!saved.ok) {
      return failed(
        "config_write_failed",
        saved.error,
        [{ stage: "config", action: "rename", ok: false, message: saved.error }],
        before,
      )
    }

    const stopped = await stop(command.name)
    const started = stopped.ok && config.enabled !== false ? await reconnect(command.newName) : { ok: true as const }
    if (stopped.ok && started.ok) return { ok: true, snapshot: await snapshot() }

    const rollback = await attempt(() =>
      McpConfigWriter.commit(scope, [
        { name: command.newName, value: undefined },
        { name: command.name, value: previous },
      ]),
    )
    const cleaned = await stop(command.newName)
    const restored = await restore(command.name, current)
    const ok = rollback.ok && cleaned.ok && restored.ok
    const primary = stopped.ok ? started : stopped
    return failed(
      ok ? (stopped.ok ? "runtime_connect_failed" : "runtime_disconnect_failed") : "compensation_failed",
      primary.ok ? "MCP rename runtime failed" : primary.error,
      [
        { stage: "config", action: "rename", ok: true },
        {
          stage: "runtime",
          action: stopped.ok ? "connect_new" : "disconnect_old",
          ok: false,
          ...(!primary.ok ? { message: primary.error } : {}),
        },
        {
          stage: "compensation",
          action: "restore_config",
          ok: rollback.ok,
          ...(!rollback.ok ? { message: rollback.error } : {}),
        },
        {
          stage: "compensation",
          action: "disconnect_new",
          ok: cleaned.ok,
          ...(!cleaned.ok ? { message: cleaned.error } : {}),
        },
        {
          stage: "compensation",
          action: "restore_old_runtime",
          ok: restored.ok,
          ...(!restored.ok ? { message: restored.error } : {}),
        },
      ],
      before,
    )
  }

  async function remove(
    command: Extract<Command, { type: "remove" }>,
    current: Server,
    before: Snapshot,
    raw: Awaited<ReturnType<typeof entries>>,
  ): Promise<Result> {
    const stopped = await stop(command.name)
    if (!stopped.ok) {
      const restored = await restore(command.name, current)
      return failed(
        restored.ok ? "runtime_disconnect_failed" : "compensation_failed",
        stopped.error,
        [
          { stage: "runtime", action: "disconnect", ok: false, message: stopped.error },
          {
            stage: "compensation",
            action: "restore_runtime",
            ok: restored.ok,
            ...(!restored.ok ? { message: restored.error } : {}),
          },
        ],
        before,
      )
    }

    const targets = (["global", "project"] as const).filter((scope) => raw[scope] !== undefined)
    const committed: McpConfigWriter.Scope[] = []
    let deletion: { scope: McpConfigWriter.Scope; error: string } | undefined
    for (const scope of targets) {
      const deleted = await attempt(() => McpConfigWriter.commit(scope, [{ name: command.name, value: undefined }]))
      if (!deleted.ok) {
        deletion = { scope, error: deleted.error }
        break
      }
      committed.push(scope)
    }
    if (!deletion) return { ok: true, snapshot: await snapshot() }

    const rollbacks: Fact[] = []
    for (const scope of committed.reverse()) {
      const value = scope === "global" ? raw.global : raw.project
      const rollback = await attempt(() => McpConfigWriter.commit(scope, [{ name: command.name, value }]))
      rollbacks.push({
        stage: "compensation",
        action: `restore_${scope}_config`,
        ok: rollback.ok,
        ...(!rollback.ok ? { message: rollback.error } : {}),
      })
    }
    const restored = await restore(command.name, current)
    const compensated = rollbacks.every((fact) => fact.ok) && restored.ok
    return failed(
      compensated ? "config_write_failed" : "compensation_failed",
      deletion.error,
      [
        { stage: "runtime", action: "disconnect", ok: true },
        {
          stage: "config",
          action: targets.length > 1 ? `remove_${deletion.scope}` : "remove",
          ok: false,
          message: deletion.error,
        },
        ...rollbacks,
        {
          stage: "compensation",
          action: "restore_runtime",
          ok: restored.ok,
          ...(!restored.ok ? { message: restored.error } : {}),
        },
      ],
      before,
    )
  }

  async function snapshot(initialize = true): Promise<Snapshot> {
    const [merged, global, project] = await Promise.all([
      Config.get(),
      Config.getGlobal(),
      Config.loadProjectMerakCodeFile(),
      ...(initialize ? [MCP.status()] : []),
    ])
    const { status, tools } = MCP.cachedSnapshot()
    const names = new Set([
      ...Object.keys(global.mcp ?? {}),
      ...Object.keys(project.mcp ?? {}),
      ...Object.keys(merged.mcp ?? {}),
    ])

    return {
      servers: [...names]
        .sort((a, b) => a.localeCompare(b))
        .flatMap((name) => {
          const globalEntry = global.mcp?.[name]
          const projectEntry = project.mcp?.[name]
          const config = materialize(globalEntry, projectEntry, merged.mcp?.[name])
          if (!config) return []
          const source = projectEntry ? "project" : "global"
          return [
            {
              name,
              scope: source,
              shadowed: globalEntry && projectEntry ? (["global"] as const) : [],
              enabled: config.enabled !== false,
              config,
              status: runtimeStatus(status[name]),
              tools: tools[name] ?? { count: 0, tools: [] },
            },
          ]
        }),
    }
  }

  export async function read(): Promise<Snapshot> {
    using _ = await Lock.read(transaction)
    return snapshot()
  }

  export async function change(input: McpManagementContract.CommandInput): Promise<Result> {
    const command = McpManagementContract.Command.parse(input)
    using _ = await Lock.write(transaction)
    let before = await snapshot(false)
    let current = before.servers.find((server) => server.name === command.name)
    if (command.type === "add" && current) {
      return {
        ok: false,
        error: {
          code: "already_exists",
          message: `MCP server ${command.name} already exists`,
          facts: [],
        },
        snapshot: before,
      }
    }
    if (command.type !== "add" && !current) {
      return {
        ok: false,
        error: { code: "not_found", message: `MCP server ${command.name} does not exist`, facts: [] },
        snapshot: before,
      }
    }
    if (command.type === "rename" && before.servers.some((server) => server.name === command.newName)) {
      return {
        ok: false,
        error: {
          code: "already_exists",
          message: `MCP server ${command.newName} already exists`,
          facts: [],
        },
        snapshot: before,
      }
    }
    if (command.type === "replace") {
      const saved = await changeDeferred(command, current!, before)
      if (saved) return saved
    }
    // Runtime mutations still initialize connections and retain their rollback semantics.
    before = await snapshot()
    current = before.servers.find((server) => server.name === command.name)
    if (command.type === "set_enabled") {
      const setting = await toggle(command.name, current!, command.enabled)
      if (!setting) return shadow(command.name, "project", before)
      return await (command.enabled
        ? enable(command.name, current!, before, setting)
        : disable(command.name, current!, before, setting))
    }

    if (command.type === "add") return await add(command, before)

    if (command.type === "remove") return await remove(command, current!, before, await entries(command.name))

    const scope = "global" as const
    const raw = await entries(command.name)
    const previous = scope === "global" ? raw.global : raw.project
    if (!configured(previous) || (scope === "global" && configured(raw.project))) {
      return shadow(command.name, current!.scope, before)
    }
    const config = command.type === "replace" ? preserveTransport(command.config, current!.config) : current!.config

    if (command.type === "replace") {
      const effective = overlay(config, raw.project)
      return await replace(command, current!, before, scope, config, previous, effective)
    }
    return await renameServer(command, current!, before, scope, config, previous)
  }
}
