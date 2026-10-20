import type {
  Event,
  createMerakCodeClient,
  Project,
  Model,
  Provider,
  PermissionRequest,
  UserMessage,
  Message,
  Part,
  Auth,
  Config,
} from "../client/index.js"

import type { PluginShell } from "./shell.js"
import { type ToolDefinition } from "./tool.js"

export * from "./tool.js"
// The shapes used by the provider hook are a public contract for plugin authors and engine-side consumers
export type { Model, Provider, Auth }
// Types of PluginInput.$ (zx-style command templates), so plugins can type code that wraps input.$ (e.g. running git)
export type { PluginShell, PluginShellPromise, PluginShellOutput, PluginShellError, ShellExpression } from "./shell.js"

export type ProviderContext = {
  source: "env" | "config" | "custom" | "api"
  info: Provider
  options: Record<string, any>
}

export type PluginInput = {
  client: ReturnType<typeof createMerakCodeClient>
  project: Project
  directory: string
  worktree: string
  serverUrl: URL
  $: PluginShell
  /**
   * This plugin's options: `config.plugin_options[id]` merged with the `options` of the module's exported
   * `{ id, server, options }` (user config wins). The engine does not interpret them; validate them with your own zod
   * schema in the `config` hook.
   */
  options: Record<string, unknown>
  /**
   * Absolute path of a persistent directory for this plugin only (isolated by plugin id, separate from other plugins
   * and from the project). It is not created in advance: call `fs.mkdir(dataDirectory, { recursive: true })` before
   * writing. Use it for state that must survive across sessions or processes (local queue files, toggles, etc.).
   * Plugins cannot import engine modules, so this is how the host hands over the equivalent of the engine's
   * `Global.Path.data`; it also follows test isolation (`MERAKCODE_TEST_HOME`).
   */
  dataDirectory: string
}

export type PluginOptions = Record<string, unknown>

export type Plugin = (input: PluginInput, options?: PluginOptions) => Promise<Hooks>

/**
 * Stable module wrapper used by MerakCode plugins.
 *
 * Keeping the server entrypoint explicit lets a package expose metadata and
 * companion entrypoints without the loader trying to execute every export.
 */
export type PluginModule = {
  id?: string
  server: Plugin
  /**
   * Default options shipped with the module; merged with config.plugin_options[id] into PluginInput.options (user
   * config wins).
   */
  options?: PluginOptions
}

export type AuthHook = {
  provider: string
  loader?: (auth: () => Promise<Auth>, provider: Provider) => Promise<Record<string, any>>
  methods: (
    | {
        type: "oauth"
        label: string
        prompts?: Array<
          | {
              type: "text"
              key: string
              message: string
              placeholder?: string
              validate?: (value: string) => string | undefined
              condition?: (inputs: Record<string, string>) => boolean
            }
          | {
              type: "select"
              key: string
              message: string
              options: Array<{
                label: string
                value: string
                hint?: string
              }>
              condition?: (inputs: Record<string, string>) => boolean
            }
        >
        authorize(inputs?: Record<string, string>): Promise<AuthOAuthResult>
      }
    | {
        /** The user enters an API key directly */
        type: "api"
        label: string
      }
  )[]
}

/**
 * OAuth authorization result. Matches `AuthOAuthResult` in opencode 1.16.2, where the misspelled `AuthOuathResult` is
 * only a deprecated alias.
 */
export type AuthOAuthResult = { url: string; instructions: string } & (
  | {
      method: "auto"
      callback(): Promise<
        | ({
            type: "success"
            provider?: string
          } & (
            | {
                refresh: string
                access: string
                expires: number
                accountId?: string
                /** Domain of a self-hosted deployment such as GitHub Enterprise */
                enterpriseUrl?: string
              }
            | { key: string }
          ))
        | {
            type: "failed"
          }
      >
    }
  | {
      method: "code"
      callback(code: string): Promise<
        | ({
            type: "success"
            provider?: string
          } & (
            | {
                refresh: string
                access: string
                expires: number
                accountId?: string
                /** Domain of a self-hosted deployment such as GitHub Enterprise */
                enterpriseUrl?: string
              }
            | { key: string }
          ))
        | {
            type: "failed"
          }
      >
    }
)

export interface Hooks {
  /** Release plugin-owned processes, listeners, timers, and other resources. */
  dispose?: () => Promise<void>
  event?: (input: { event: Event }) => Promise<void>
  config?: (input: Config) => Promise<void>
  tool?: {
    [key: string]: ToolDefinition
  }
  auth?: AuthHook
  /**
   * Provider extension hook: the same shape as the opencode plugin `ProviderHook`, extended with `providers` and
   * `fetch`. Use it to register private provider catalogs and to wrap the network requests behind model calls
   * (enterprise gateways, content moderation, etc.).
   */
  provider?: {
    /**
     * For `models`, this is the **id of the target provider** (opencode semantics): the engine passes a provider to
     * `models` only when its id equals `id`. `providers` and `fetch` are MerakCode extensions that ignore `id` and
     * apply to every provider; for them `id` is just the plugin's own label.
     */
    id: string
    /** Registers a complete custom provider catalog, keyed by providerID. */
    providers?(): Promise<Record<string, Provider>>
    /**
     * Returns the **complete** model list for the provider that `id` points at (same shape as opencode 1.16.2): the
     * result replaces the models already enumerated instead of being merged with them; an empty object means no
     * models are available and the provider is not listed. Keys are modelIDs; the engine normalizes each model's
     * `id` / `providerID` from its key.
     */
    models?(provider: Provider, ctx: { auth?: Auth }): Promise<Record<string, Model>>
    /**
     * Wraps the network request behind a model call. Plugins nest in load order (later plugins wrap earlier ones).
     * `next` is the next inner fetch in the chain (the real network fetch when there is none); call it to let the
     * request through.
     */
    fetch?(
      request: Request,
      ctx: { providerID: string; modelID: string; sessionID?: string; next: typeof fetch },
    ): Promise<Response>
  }
  /**
   * Called when a new message is received
   */
  "chat.message"?: (
    input: {
      sessionID: string
      agent?: string
      model?: { providerID: string; modelID: string }
      messageID?: string
      variant?: string
    },
    output: { message: UserMessage; parts: Part[] },
  ) => Promise<void>
  /**
   * Modify parameters sent to LLM
   */
  "chat.params"?: (
    input: { sessionID: string; agent: string; model: Model; provider: ProviderContext; message: UserMessage },
    output: {
      temperature: number
      topP: number
      topK: number
      /** Output token limit for this turn (same as @opencode-ai/plugin@1.16.2); undefined uses the provider default */
      maxOutputTokens: number | undefined
      options: Record<string, any>
    },
  ) => Promise<void>
  "chat.headers"?: (
    input: { sessionID: string; agent: string; model: Model; provider: ProviderContext; message: UserMessage },
    output: { headers: Record<string, string> },
  ) => Promise<void>
  "permission.ask"?: (input: PermissionRequest, output: { status: "ask" | "deny" | "allow" }) => Promise<void>
  "command.execute.before"?: (
    input: { command: string; sessionID: string; arguments: string },
    output: { parts: Part[] },
  ) => Promise<void>
  "tool.execute.before"?: (
    input: { tool: string; sessionID: string; callID: string },
    output: { args: any },
  ) => Promise<void>
  /**
   * sessionID/callID are only set for the bash tool (same as @opencode-ai/plugin@1.16.2); PTY and generic shell calls
   * omit them
   */
  "shell.env"?: (
    input: { cwd: string; sessionID?: string; callID?: string },
    output: { env: Record<string, string> },
  ) => Promise<void>
  "tool.execute.after"?: (
    input: { tool: string; sessionID: string; callID: string; args: any },
    output: {
      title: string
      output: string
      metadata: any
    },
  ) => Promise<void>
  "experimental.chat.messages.transform"?: (
    input: {},
    output: {
      messages: {
        info: Message
        parts: Part[]
      }[]
    },
  ) => Promise<void>
  "experimental.chat.system.transform"?: (
    input: { sessionID?: string; model: Model },
    output: {
      system: string[]
    },
  ) => Promise<void>
  /**
   * Called before session compaction starts. Allows plugins to customize
   * the compaction prompt.
   *
   * - `context`: Additional context strings appended to the default prompt
   * - `prompt`: If set, replaces the default compaction prompt entirely
   */
  "experimental.session.compacting"?: (
    input: { sessionID: string },
    output: { context: string[]; prompt?: string },
  ) => Promise<void>
  "experimental.text.complete"?: (
    input: { sessionID: string; messageID: string; partID: string },
    output: { text: string },
  ) => Promise<void>
  /**
   * Modify tool definitions (description and parameters) sent to LLM
   */
  "tool.definition"?: (input: { toolID: string }, output: { description: string; parameters: any }) => Promise<void>
  /**
   * Refuses a whole turn. Fires after a real user message is persisted and before the tool loop starts (not for
   * `role !== "user"` or trusted internal dispatches). Like `permission.ask`, but for the whole prompt instead of one
   * tool call: when `refuse` is set, the tool loop is skipped and `output.message` is returned as the assistant reply.
   * With no plugin registered, `output.refuse` stays `false`.
   */
  "experimental.chat.guard"?: (
    input: { sessionID: string; agent: string; role: string; parts: Part[] },
    output: { refuse: boolean; message: string },
  ) => Promise<void>
  /**
   * Last filter before compaction summarizes the messages. Fires after the engine's built-in sensitive path redaction
   * (`redactSensitiveToolOutputs`) and before the messages reach the summary model, so plugins can rewrite or filter
   * them; `experimental.session.compacting` can only add context or replace the prompt, not change the messages.
   * With no plugin registered, `messages` pass through unchanged.
   */
  "experimental.compaction.messages.transform"?: (
    input: { sessionID: string },
    output: { messages: { info: Message; parts: Part[] }[] },
  ) => Promise<void>
  /**
   * Path decision at the tool level. Fires after a tool has **resolved its absolute target paths** and **before it
   * reads or writes**.
   *
   * Why not `tool.execute.before`: it receives the tool's **raw arguments**, which may be relative paths, glob patterns
   * or no path at all (grep's `path` is optional). The decision has to be made on the resolved targets.
   *
   * **Deny only**: a plugin adds paths to `denied` and the engine refuses them; a path another plugin denied cannot be
   * allowed again. The security floor is not negotiable.
   *
   * For single-path tools (read/write/edit) a denied path throws with the refusal message; when filtering multiple
   * paths (ls/glob/grep entries) a denied entry is skipped without failing the whole call. With no plugin registered,
   * `denied` stays empty and the engine makes no path decisions.
   */
  "experimental.tool.path.guard"?: (
    input: {
      sessionID: string
      tool: string
      paths: string[]
      /**
       * The latest real user text of this turn (already computed by the engine at this point). Checks such as source
       * leak protection need the user's current intent (maintaining or fixing code is fine, asking for the
       * implementation is not), which the paths alone cannot tell. Passing it saves plugins from reading the session.
       */
      text: string
    },
    output: {
      denied: string[]
      /**
       * Optional refusal message (same shape as `message` in `experimental.chat.guard`).
       *
       * Used as the error message when a single-path call is denied; without it the engine uses a neutral default
       * (`ToolPathGuard.DENIED_MESSAGE`). **Both the decision and its wording belong to the product**: the engine
       * should not decide how a product explains a refusal, so the message comes from the plugin with the decision.
       * Not used when filtering multiple paths (denied paths are dropped silently, with no user-facing message).
       */
      message?: string
    },
  ) => Promise<void>
  /**
   * Output-side safeguard for compaction summaries. Fires after the summary model has produced its text and before it
   * is written back to the session, so plugins can redact the finished summary.
   *
   * `experimental.compaction.messages.transform` handles the messages **going in**; this hook handles the summary
   * **coming out**. Both are needed: the summary model may restate internal implementation details from ordinary
   * messages that never touched a sensitive path, and only the output side can catch that.
   *
   * Rewriting `output.summary` takes effect; with no plugin registered the summary passes through unchanged.
   */
  "experimental.compaction.summary.transform"?: (
    input: { sessionID: string },
    output: { summary: string },
  ) => Promise<void>
  /**
   * Outbound review of the complete message. Fires **before the assistant message's final text is written**, with the
   * **complete text joined across all text parts**.
   *
   * **Why `experimental.text.complete` is not enough**: it fires at the end of **each text part**, while content
   * review judges the whole answer; text that passes part by part but not as a whole slips through. The two are not
   * interchangeable.
   *
   * **Why transform rather than block**: a review plugin should replace violating output with a safe refusal instead
   * of aborting the whole turn.
   *
   * Rewriting `output.text` takes effect: the engine stores the rewritten text as the final version (the original text
   * parts are cleared and the result is written as a single part). With no plugin registered the text passes through
   * unchanged.
   */
  "experimental.message.complete.transform"?: (
    input: {
      sessionID: string
      messageID: string
      /** This hook only fires for the final text, so this is always true. */
      final: true
    },
    output: { text: string },
  ) => Promise<void>
}
