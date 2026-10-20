import { Message } from "../session/message"
import type { Tool } from "./tool"
import { Text } from "../util/text"

/**
 * Seam for path decisions at the tool layer.
 *
 * This is only plumbing, with no decisions of its own: it passes the absolute paths each tool has resolved to the
 * `experimental.tool.path.guard` hook and denies only what plugins deny. The engine has no product policy here
 * (sensitive path lists, intent detection and denial messages all belong to plugins).
 *
 * Why the plumbing must stay in the engine: `tool.execute.before` sees the tool's raw input (perhaps a relative path,
 * a glob pattern, or no path at all, since grep's `path` is optional), while path decisions need the absolute paths
 * each tool resolves internally. Without this hook point, plugins could not reach the files actually read or written.
 *
 * The hook only accepts `denied`, never `allowed`: a plugin can deny more, but cannot let back in a path that another
 * plugin denied.
 *
 * When a hook throws, `Plugin.trigger` catches it and marks the plugin as degraded (nothing reaches the tool), and
 * `denied` stays empty, so a broken plugin does not deny normal paths.
 */
export namespace ToolPathGuard {
  /** Neutral fallback when a plugin gives no denial message; product wording comes from plugins through the hook */
  export const DENIED_MESSAGE = {
    zh: "该路径已被安全策略拒绝访问。",
    en: "Access to this path was denied by the security policy.",
  }

  /**
   * Texts of the latest user message with real content, passed to the hook as `text`.
   *
   * Continuation messages after compaction (the continuation message in compaction.ts and the subagent summary
   * continuation in runner.ts) consist only of synthetic parts. Looking only at the newest user message would give
   * empty text, and plugin decisions that depend on the user's current intent would lose the intent established
   * before compaction. So this walks back to the latest user message with real (not synthetic, not ignored) text.
   *
   * The engine computes this once instead of every plugin reading the session again.
   */
  export function latestUserTexts(messages: Message.FullMsg[]) {
    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i]
      if (msg.info.role !== "user") continue
      const texts = Message.userSourceTexts(msg)
      if (texts.length) return texts
    }
    return [""]
  }

  export function latestUserText(messages: Message.FullMsg[]) {
    return latestUserTexts(messages)[0] ?? ""
  }

  async function deniedByPlugin(ctx: Tool.Context, tool: string, candidates: string[], text: string) {
    if (candidates.length === 0) return { denied: new Set<string>(), message: undefined as string | undefined }
    const { Plugin } = await import("../plugin")
    const output = await Plugin.trigger(
      "experimental.tool.path.guard",
      { sessionID: ctx.sessionID, tool, paths: candidates, text },
      { denied: [] as string[], message: undefined as string | undefined },
    )
    return { denied: new Set(output.denied), message: output.message }
  }

  /** Single path (read/write/edit/multi_edit, and the root path of glob/grep/ls): throws when denied */
  export async function assertPathAllowed(ctx: Tool.Context, target: string, tool: string) {
    for (const text of latestUserTexts(ctx.messages)) {
      const { denied, message } = await deniedByPlugin(ctx, tool, [target], text)
      // Each source text is judged separately, so display text (such as a "fix" label) joined into a sensitive
      // template cannot let the path through by mistake
      if (denied.has(target)) throw new Error(message || (await Text.pick(DENIED_MESSAGE)))
    }
  }

  /** Many paths (filtering ls/glob/grep results): denied entries are dropped without failing the tool */
  export async function filterAllowedPaths(ctx: Tool.Context, targets: string[], tool: string) {
    const denied = new Set<string>()
    for (const text of latestUserTexts(ctx.messages)) {
      const result = await deniedByPlugin(ctx, tool, targets, text)
      for (const target of result.denied) denied.add(target)
    }
    return denied.size === 0 ? targets : targets.filter((target) => !denied.has(target))
  }
}
