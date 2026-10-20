import type { Hooks, PluginInput, Plugin as PluginInstance, PluginModule, PluginOptions } from "@merakcode/sdk/plugin"
import path from "path"
import { existsSync } from "fs"
import { Config } from "../config/config"
import { Bus } from "../bus"
import { GlobalBus } from "../bus/global"
import { Log } from "@merakcode/log/logger"
import { createMerakCodeClient } from "@merakcode/sdk/client"
import { getLocalSecret } from "../auth/local-secret"
import { Server } from "../server/server"
import { Npm } from "../npm"
import { createPluginShell } from "./shell"
import { Instance } from "../project/instance"
import { Flag } from "../flag/flag"
import { Global } from "../global"
import { Session } from "../session"
import { Message } from "../session/message"
import { Text } from "../util/text"

export namespace Plugin {
  const log = Log.create({ service: "plugin" })

  export type Status = "active" | "degraded" | "failed"

  export type Info = {
    id: string
    spec: string
    source: "internal" | "config"
    status: Status
    error?: string
    tools: string[]
  }

  type Entry = {
    hooks: Hooks
    info: Info
  }

  type Server = {
    id?: string
    run: PluginInstance
    options?: PluginOptions
  }

  function message(error: unknown) {
    return error instanceof Error ? error.message : String(error)
  }

  /**
   * Plugin specs written as local paths (absolute, `./`, `../`) are not npm packages and must not reach the
   * installer. The config layer already turned resolvable ones into file URLs, so reaching this means resolution
   * failed; returns the reason to show the user.
   */
  function localSpecError(spec: string, lang: Text.Lang) {
    if (/^\.{1,2}[\\/]/.test(spec))
      return Text.format(
        {
          zh: "本地插件的相对路径无法解析：{spec}。文件配置按配置文件所在目录解析；内联配置没有基准目录，请改用绝对路径或 file URL",
          en: "Cannot resolve the relative path of local plugin: {spec}. File configs resolve it against the config file's directory; inline configs have no base directory, so use an absolute path or a file URL",
        },
        lang,
        { spec },
      )
    if (!path.isAbsolute(spec)) return
    return existsSync(spec)
      ? Text.format({ zh: "本地插件入口无法解析：{spec}", en: "Cannot resolve the local plugin entry: {spec}" }, lang, {
          spec,
        })
      : Text.format({ zh: "本地插件不存在：{spec}", en: "Local plugin does not exist: {spec}" }, lang, { spec })
  }

  function module(value: unknown): value is PluginModule {
    return !!value && typeof value === "object" && "server" in value && typeof value.server === "function"
  }

  /**
   * Resolve both the historical function export and the explicit
   * `{ id, server }` module shape used by current community plugins.
   */
  export function servers(mod: Record<string, unknown>): Server[] {
    const result: Server[] = []
    const seen = new Set<PluginInstance>()

    const add = (value: unknown) => {
      const id = module(value) ? value.id : undefined
      const run = module(value) ? value.server : typeof value === "function" ? (value as PluginInstance) : undefined
      const options = module(value) ? value.options : undefined
      if (!run || seen.has(run)) return
      seen.add(run)
      result.push({ id, run, options })
    }

    add(mod.default)
    for (const [name, value] of Object.entries(mod)) {
      if (name === "default") continue
      add(value)
    }

    if (!result.length) throw new TypeError("Plugin module has no server entrypoint")
    return result
  }

  function info(input: { id: string; spec: string; source: Info["source"]; hooks?: Hooks; error?: unknown }): Info {
    return {
      id: input.id,
      spec: input.spec,
      source: input.source,
      status: input.error ? "failed" : "active",
      error: input.error ? message(input.error) : undefined,
      tools: Object.keys(input.hooks?.tool ?? {}),
    }
  }

  /**
   * Adds the local auth header to the plugin's in-process client (matches opencode 1.16.2's
   * `headers: ServerAuth.headers()`).
   *
   * With a password set (`MERAKCODE_SERVER_PASSWORD`), the Basic Auth middleware in `server.ts` answers 401 to
   * requests without credentials. The plugin client goes through `Server.App().fetch` (in-process, no network), but
   * the middleware chain still runs, so plugins reading messages via `input.client` would silently get undefined.
   * This affects both the main process and the worker when CLI `serve` has a password.
   *
   * The secret is read per request (tests change it after the plugin state is created).
   * Requests that already carry authorization are left alone: a plugin may use other credentials for a third party.
   */
  function withLocalAuth(input: RequestInfo | URL, init?: RequestInit): Request {
    const request = input instanceof Request && !init ? input : new Request(input as RequestInfo, init)
    if (request.headers.has("authorization")) return request
    const secret = getLocalSecret()
    if (!secret) return request
    const username = Flag.MERAKCODE_SERVER_USERNAME ?? "merakcode"
    const next = new Request(request)
    next.headers.set("authorization", `Basic ${Buffer.from(`${username}:${secret}`).toString("base64")}`)
    return next
  }

  const state = Instance.state(
    async () => {
      const client = createMerakCodeClient({
        baseUrl: "http://localhost:4096",
        directory: Instance.directory,
        // @ts-ignore - fetch type incompatibility
        fetch: async (input: RequestInfo | URL, init?: RequestInit) =>
          Server.App().fetch(withLocalAuth(input, init) as Request),
      })
      const config = await Config.get()
      const entries: Entry[] = []
      const input: PluginInput = {
        client,
        project: Instance.project,
        worktree: Instance.worktree,
        directory: Instance.directory,
        serverUrl: Server.url(),
        $: createPluginShell(),
        options: {},
        dataDirectory: "",
      }
      // Each plugin gets its own input.options: the module's exported options merged with
      // config.plugin_options[id], user config winning.
      // `dataDirectory` is per plugin id under `Global.Path.data/plugin/<id>`, so it follows the
      // `MERAKCODE_TEST_HOME` test isolation automatically.
      // Plugins create the directory themselves before the first write (`fs.mkdir(dataDirectory, { recursive: true })`);
      // the engine does not, since most plugins need no local storage and should not pay a mkdir at startup.
      const inputFor = (id: string, moduleOptions?: PluginOptions): PluginInput => ({
        ...input,
        dataDirectory: path.join(Global.Path.data, "plugin", id),
        options: { ...moduleOptions, ...config.plugin_options?.[id] },
      })

      /** Initializes each entrypoint of a plugin module and records the result in entries */
      async function register(
        loaded: Server[],
        spec: string,
        fallbackID: string,
        source: Info["source"],
        entryOptions?: PluginOptions,
      ) {
        for (const server of loaded) {
          const id = server.id ?? fallbackID
          // Precedence: module options < tuple options < config.plugin_options[id] (merged in inputFor)
          const merged = entryOptions ? { ...server.options, ...entryOptions } : server.options
          const hooks = await server.run(inputFor(id, merged), merged).catch((error) => {
            log.error("failed to initialize plugin", { id, path: spec, error })
            entries.push({ hooks: {}, info: info({ id, spec, source, error }) })
            return undefined
          })
          if (!hooks) continue
          entries.push({ hooks, info: info({ id, spec, source, hooks }) })
        }
      }

      // Wait for the `.merakcode/` dependency install (30s timeout) only when the user configured plugins; otherwise
      // the first prompt would wait for nothing when offline
      const user = config.plugin ?? []
      if (user.length) await Config.waitForDependencies()

      const source = "config" as const
      for (const entry of user) {
        // opencode 1.16.2 `[name, options]` tuple: options are passed as the second argument of server() and merged
        // into PluginInput.options (config.plugin_options wins).
        const spec = Config.pluginSpecifier(entry)
        const entryOptions = typeof entry === "string" ? undefined : entry[1]
        let plugin = spec
        log.info("loading plugin", { path: plugin })
        const fallbackID = Config.getPluginName(spec)
        const local = localSpecError(spec, await Text.lang())
        if (local) {
          log.error("failed to resolve local plugin", { path: spec, reason: local })
          entries.push({ hooks: {}, info: info({ id: fallbackID, spec, source, error: new Error(local) }) })
          continue
        }
        if (!plugin.startsWith("file://")) {
          const lastAtIndex = plugin.lastIndexOf("@")
          const pkg = lastAtIndex > 0 ? plugin.substring(0, lastAtIndex) : plugin
          const version = lastAtIndex > 0 ? plugin.substring(lastAtIndex + 1) : "latest"
          plugin = await Npm.cached(pkg, version).catch((err) => {
            const reason = message(err)
            log.error("failed to install plugin", {
              pkg,
              version,
              error: reason,
            })
            Bus.publish(Session.Event.Error, {
              error: new Message.PluginInstallError({
                package: pkg,
                version,
                reason,
                messageKey: "error.pluginInstall",
                params: { package: pkg, version, reason },
                message: `Failed to install plugin ${pkg}@${version}: ${reason}`,
              }).toObject(),
            })
            entries.push({ hooks: {}, info: info({ id: fallbackID, spec, source, error: err }) })
            return ""
          })
          if (!plugin) continue
        }

        const loaded = await import(Npm.entry(plugin))
          .then((mod) => servers(mod as Record<string, unknown>))
          .catch((error) => {
            log.error("failed to import plugin", { path: spec, error })
            entries.push({ hooks: {}, info: info({ id: fallbackID, spec, source, error }) })
            return [] as Server[]
          })

        await register(loaded, spec, fallbackID, source, entryOptions)
      }

      return {
        entries,
        input,
        // Unsubscribes the GlobalBus forwarder; set by init() on first registration. GlobalBus is a process-wide
        // EventEmitter, so unlike the per-Instance Bus its listeners are not dropped with the Instance and must be
        // removed explicitly.
        globalBusOff: undefined as (() => void) | undefined,
      }
    },
    async ({ entries, globalBusOff }) => {
      globalBusOff?.()
      for (const entry of entries) {
        await entry.hooks.dispose?.().catch((error) => {
          log.error("plugin dispose hook failed", { id: entry.info.id, error })
        })
      }
    },
  )

  /**
   * Gate hooks: as in opencode 1.16.2, a plugin that throws rejects the tool call or command, and the error reaches
   * the caller unchanged. A rejection is a normal outcome, not a plugin failure, so the status is not changed. Other
   * hooks stay fault-tolerant: throwing only marks the plugin degraded.
   */
  const GATE_HOOKS = new Set<string>(["tool.execute.before", "command.execute.before"])

  export async function trigger<
    Name extends Exclude<keyof Required<Hooks>, "auth" | "event" | "tool" | "provider">,
    Input = Parameters<Required<Hooks>[Name]>[0],
    Output = Parameters<Required<Hooks>[Name]>[1],
  >(name: Name, input: Input, output: Output): Promise<Output> {
    if (!name) return output
    for (const entry of await state().then((x) => x.entries)) {
      const fn = entry.hooks[name]
      if (!fn) continue
      // @ts-expect-error if you feel adventurous, please fix the typing, make sure to bump the try-counter if you
      // give up.
      // try-counter: 2
      await fn(input, output).catch((error) => {
        if (GATE_HOOKS.has(name)) {
          log.warn("plugin gate rejected", { id: entry.info.id, hook: name })
          throw error
        }
        entry.info.status = "degraded"
        entry.info.error = message(error)
        log.error("plugin hook failed", { id: entry.info.id, hook: name, error })
      })
    }
    return output
  }

  export async function list() {
    return state().then((x) => x.entries.filter((entry) => entry.info.status !== "failed").map((entry) => entry.hooks))
  }

  /**
   * Provider extension hook: merges the provider catalogs registered by every plugin's `provider.providers()`.
   * Merged in load order, so a later plugin overrides an earlier one with the same id; returns an empty object when
   * no plugin registers the hook. A failing hook only degrades that plugin, as with other hooks.
   */
  export async function customProviders(): Promise<Record<string, import("@merakcode/sdk/plugin").Provider>> {
    const merged: Record<string, import("@merakcode/sdk/plugin").Provider> = {}
    for (const entry of await state().then((x) => x.entries)) {
      const providers = await entry.hooks.provider?.providers?.().catch((error) => {
        entry.info.status = "degraded"
        entry.info.error = message(error)
        log.error("plugin provider.providers hook failed", { id: entry.info.id, error })
        return undefined
      })
      if (providers) Object.assign(merged, providers)
    }
    return merged
  }

  /**
   * Whether any plugin registers `provider.models`. Callers use it to skip the per-provider "read auth, call hook"
   * loop: `Auth.get()` reads from disk every time, which is pure overhead when no plugin implements the hook.
   */
  export async function hasProviderModels(): Promise<boolean> {
    return state().then((x) => x.entries.some((entry) => !!entry.hooks.provider?.models))
  }

  /**
   * Provider extension hook: returns a plugin's complete model list for a provider. `ProviderHook.models` is an
   * opencode 1.16.2 key, so filtering and merging follow its semantics.
   *
   * For this hook `provider.id` names the target provider: opencode only passes `database[hook.id]` to the hook, so
   * plugins ported from opencode do not check `provider.id` themselves. Likewise only plugins whose `id` matches the
   * target provider are called; calling every plugin for every provider would add its models to all providers. (Our
   * own `providers`/`fetch` extensions apply to all providers.)
   *
   * The hook must be wired, not just typed: silently ignoring `models` in a plugin ported from opencode would be a
   * broken promise that is harder to diagnose than no support.
   *
   * `undefined` means no plugin handles this provider and the caller must keep the models it listed; an object (even
   * empty) is the plugin's complete answer and replaces them. With several plugins for the same id, later plugins
   * win. A failing hook only degrades that plugin (fail-open: a broken plugin does not take down the catalog).
   */
  export async function customModels(
    provider: import("@merakcode/sdk/plugin").Provider,
    ctx: { auth?: import("@merakcode/sdk/plugin").Auth },
  ): Promise<Record<string, import("@merakcode/sdk/plugin").Model> | undefined> {
    let result: Record<string, import("@merakcode/sdk/plugin").Model> | undefined
    for (const entry of await state().then((x) => x.entries)) {
      const hook = entry.hooks.provider
      if (!hook?.models || hook.id !== provider.id) continue
      const models = await hook.models(provider, ctx).catch((error) => {
        entry.info.status = "degraded"
        entry.info.error = message(error)
        log.error("plugin provider.models hook failed", { id: entry.info.id, provider: provider.id, error })
        return undefined
      })
      if (models) result = models
    }
    return result
  }

  /**
   * Provider extension hook: wraps `base` with every plugin's `provider.fetch` in load order (later plugins outside,
   * see the hook docs in @merakcode/sdk/plugin). Without such plugins `base` is returned as is, with no Request built
   * and no behavior change.
   */
  export async function wrapProviderFetch(
    ctx: { providerID: string; modelID: string; sessionID?: string },
    base: typeof fetch,
  ): Promise<typeof fetch> {
    const entries = await state().then((x) => x.entries)
    const hooks = entries.flatMap((entry) =>
      entry.hooks.provider?.fetch ? [{ entry, fn: entry.hooks.provider.fetch }] : [],
    )
    if (hooks.length === 0) return base
    // base is the provider's options.fetch (request signing, proxies, ...) and, per the AI SDK convention, takes
    // (url, init{ headers: Record, body: string }). The chain passes a Request, so it must be unpacked into that shape
    // before calling base; otherwise a fetch reading init.body / init.headers gets nothing once any hook is registered.
    const innermost = (async (input: RequestInfo | URL, init?: RequestInit) => {
      if (!(input instanceof Request)) return base(input, init)
      return base(input.url, {
        method: input.method,
        headers: Object.fromEntries(input.headers),
        body: input.body ? await input.text() : undefined,
        signal: input.signal,
        ...init,
      })
    }) as typeof fetch
    return hooks.reduce((inner, { entry, fn }) => {
      const wrapped = (async (input: RequestInfo | URL, init?: RequestInit) => {
        const request = input instanceof Request ? input : new Request(input, init)
        // method/headers/body/signal are in the Request. The rest are Node fetch extensions (dispatcher: the connection
        // pool with trust chain and timeouts) that a standard Request silently drops. Each next(request) passes them
        // back to inner; otherwise a fetch hook would lose the pool provider.ts sets up and long requests would hit the
        // default timeout.
        const { method: _m, headers: _h, body: _b, signal: _s, ...extras } = (init ?? {}) as Record<string, unknown>
        const next = ((req: RequestInfo | URL, override?: RequestInit) =>
          inner(req, { ...extras, ...override } as RequestInit)) as typeof fetch
        return fn(request, { ...ctx, next }).catch((error) => {
          entry.info.status = "degraded"
          entry.info.error = message(error)
          log.error("plugin provider.fetch hook failed", { id: entry.info.id, error })
          throw error
        })
      }) as typeof fetch
      return wrapped
    }, innermost)
  }

  export async function statuses() {
    return state().then((x) => x.entries.map((entry) => ({ ...entry.info, tools: [...entry.info.tools] })))
  }

  /**
   * Adds a plugin to the project (or global) config file; for duplicate names only the last one added is kept.
   * Takes effect the next time the config is loaded.
   */
  export async function add(input: { specifier: string; scope?: "project" | "global" }) {
    const current =
      input.scope === "global" ? await Config.loadGlobalMerakCodeFile() : await Config.loadProjectMerakCodeFile()
    const plugin = Config.deduplicatePlugins([...(current.plugin ?? []), input.specifier])
    if (input.scope === "global") await Config.updateGlobal({ plugin })
    else await Config.updateProjectMerakCode({ plugin })
  }

  /** Removes a plugin from the config file by name or full spec; returns false when it is not there */
  export async function remove(input: { name: string; scope?: "project" | "global" }) {
    const current =
      input.scope === "global" ? await Config.loadGlobalMerakCodeFile() : await Config.loadProjectMerakCodeFile()
    const name = Config.getPluginName(input.name)
    // Entries may be [name, options] tuples: match on the spec and remove the whole entry
    const plugin = (current.plugin ?? []).filter((entry) => {
      const specifier = Config.pluginSpecifier(entry)
      return specifier !== input.name && Config.getPluginName(specifier) !== name
    })
    if (plugin.length === (current.plugin ?? []).length) return false
    if (input.scope === "global") await Config.updateGlobal({ plugin })
    else await Config.updateProjectMerakCode({ plugin })
    return true
  }

  export async function init() {
    const snapshot = await state()
    const entries = snapshot.entries
    const config = await Config.get()
    for (const entry of entries) {
      await entry.hooks.config?.(config).catch((error) => {
        entry.info.status = "degraded"
        entry.info.error = message(error)
        log.error("plugin config hook failed", { id: entry.info.id, error })
      })
    }
    Bus.subscribeAll(async (input) => {
      const entries = await state().then((x) => x.entries)
      for (const entry of entries) {
        await entry.hooks.event?.({ event: input }).catch((error) => {
          entry.info.status = "degraded"
          entry.info.error = message(error)
          log.error("plugin event hook failed", { id: entry.info.id, error })
        })
      }
    })
    // GlobalBus (process-wide, for cross-Instance broadcasts such as OIDC login state) and Bus (per-Instance pub/sub)
    // are separate: `Bus.subscribeAll` never sees `GlobalBus.emit(...)`. Forward GlobalBus events into the same
    // `event` hook so plugins only filter on `event.type`. `snapshot.globalBusOff` guards against registering twice
    // when init() runs again for the same Instance; GlobalBus is a real process singleton, so duplicates would leak.
    //
    // `state()` resolves the current Instance via `context.use()` (AsyncLocalStorage), which throws without an
    // ambient context. `GlobalBus.emit(...)` can fire from anywhere (OIDC changes often come from token refresh
    // timers outside `Instance.provide()`), and the resulting rejected promise is neither awaited nor caught by
    // EventEmitter; this once hung the whole worker in apps/cli's worker-oidc test. So the handler re-enters the
    // Instance captured at init() time via `Instance.provide()` before calling `state()`.
    if (!snapshot.globalBusOff) {
      const directory = Instance.directory
      const handler = async (input: { directory?: string; payload: { type?: string; properties?: unknown } }) => {
        await Instance.provide({
          directory,
          fn: async () => {
            const entries = await state().then((x) => x.entries)
            for (const entry of entries) {
              await entry.hooks.event?.({ event: input.payload as never }).catch((error) => {
                entry.info.status = "degraded"
                entry.info.error = message(error)
                log.error("plugin event hook failed", { id: entry.info.id, error })
              })
            }
          },
        }).catch((error) => {
          log.error("plugin globalBus event dispatch failed", { error })
        })
      }
      GlobalBus.on("event", handler)
      snapshot.globalBusOff = () => GlobalBus.off("event", handler)
    }
  }
}
