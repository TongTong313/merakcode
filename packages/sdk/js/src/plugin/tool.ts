import { z } from "zod"

export type ToolContext = {
  sessionID: string
  messageID: string
  agent: string
  /**
   * Current project directory for this session.
   * Prefer this over process.cwd() when resolving relative paths.
   */
  directory: string
  /**
   * Project worktree root for this session.
   * Useful for generating stable relative paths (e.g. path.relative(worktree, absPath)).
   */
  worktree: string
  abort: AbortSignal
  metadata(input: { title?: string; metadata?: { [key: string]: any } }): void
  ask(input: AskInput): Promise<void>
}

type AskInput = {
  permission: string
  patterns: string[]
  always: string[]
  metadata: { [key: string]: any }
}

/**
 * Return value of a plugin tool. Same shape as `ToolResult` in opencode 1.16.2 (see its `tool.d.ts`): either a string
 * or an object with a title and metadata.
 *
 * Plugins ported from opencode return objects whenever they show a tool title in the UI or put structured data in
 * `ToolPart.state.metadata`. Accepting only strings would pass the whole value to `Truncate.output` as output and
 * silently drop the title and metadata.
 */
export type ToolResult =
  | string
  | {
      title?: string
      output: string
      metadata?: { [key: string]: any }
      /** Attachments (images, file excerpts, etc.), shaped like the attachments of the engine's built-in tools */
      attachments?: any[]
    }

/** Normalizes both forms of {@link ToolResult} to the object form; used by the engine's ToolRegistry and by tests */
export function normalizeToolResult(result: ToolResult): Exclude<ToolResult, string> {
  return typeof result === "string" ? { output: result } : result
}

export function tool<Args extends z.ZodRawShape>(input: {
  description: string
  args: Args
  execute(args: z.infer<z.ZodObject<Args>>, context: ToolContext): Promise<ToolResult>
}) {
  return input
}
tool.schema = z

export type ToolDefinition = ReturnType<typeof tool>
