import z from "zod"
import type { Message } from "../session/message"
import type { Agent } from "../agent/agent"
import type { PermissionNext } from "../permission/next"
import type { PermissionMode } from "../permission/mode"
import { Truncate } from "./truncation"

export namespace Tool {
  interface Metadata {
    [key: string]: any
  }

  export interface InitContext {
    agent?: Agent.Info
  }

  export type Context<M extends Metadata = Metadata> = {
    sessionID: string
    messageID: string
    agent: string
    /** Permission mode of the session (child sessions follow the main session), set by the runner */
    permissionMode?: PermissionMode.Value
    /** @deprecated Use permissionMode; kept for older tool contexts. */
    kind?: PermissionMode.Value
    abort: AbortSignal
    callID?: string
    extra?: { [key: string]: any }
    messages: Message.FullMsg[]
    /** Permission rules in effect for this call (agent and session permissions merged, in priority order) */
    ruleset: PermissionNext.Ruleset
    /**
     * Reports an intermediate progress snapshot; title and metadata are merged into ToolPart.state.
     *
     * The real implementation (metadata in session/runner.ts) is async and awaits `Session.updatePart`. The return
     * type keeps void for the many fire-and-forget callers (bash, edit, subagent, ...) and also allows Promise<void>
     * so callers that need ordering (such as the workflow main loop) can await it.
     */
    metadata(input: { title?: string; metadata?: M }): void | Promise<void>
    /**
     * Asks for approval. checks are the items to judge (files, command segments, domains and so on, classified by
     * PermissionPolicy); permission is the approval category the approval bar shows. Older callers that only pass
     * patterns are judged by the permission key.
     */
    ask(
      input: Omit<PermissionNext.AskInput, "id" | "sessionID" | "tool" | "ruleset" | "root" | "source">,
    ): Promise<void>
  }
  export interface Info<Parameters extends z.ZodType = z.ZodType, M extends Metadata = Metadata> {
    id: string
    /**
     * Search signal for deferred tools: a bag of Chinese and English aliases for when to use the tool.
     *
     * Only used for tool-discovery scoring (see {@link import("./tool-discovery")}) and never rendered into a prompt:
     * showing the hint to the model brought no benefit, but it is a strong scoring signal. It is a bag of words rather
     * than a sentence, without stop words, so Chinese queries can match English tool ids (e.g. the Chinese word for
     * "workflow" matches workflow_run).
     *
     * Static rather than returned by init(), so scoring does not pay for initializing the tool. Not needed for tools
     * that are not deferred.
     */
    triggerHint?: string
    init: (ctx?: InitContext) => Promise<{
      description: string
      parameters: Parameters
      execute(
        args: z.infer<Parameters>,
        ctx: Context,
      ): Promise<{
        title: string
        metadata: M
        output: string
        attachments?: Message.FilePart[]
        /** When true, the LLM turn ends once the tool result is saved, with no follow-up step */
        stop?: boolean
      }>
      formatValidationError?(error: z.ZodError): string
    }>
  }

  export type InferParameters<T extends Info> = T extends Info<infer P> ? z.infer<P> : never
  export type InferMetadata<T extends Info> = T extends Info<any, infer M> ? M : never

  export function define<Parameters extends z.ZodType, Result extends Metadata>(
    id: string,
    init: Info<Parameters, Result>["init"] | Awaited<ReturnType<Info<Parameters, Result>["init"]>>,
    /** See {@link Info.triggerHint}: search terms for deferred tools, used for scoring only */
    triggerHint?: string,
  ): Info<Parameters, Result> {
    return {
      id,
      triggerHint,
      init: async (initCtx) => {
        // A static object must be copied: it is shared at module level, and assigning the wrapped execute below
        // would modify it, so every later init() would wrap the already wrapped version again.
        const toolInfo = init instanceof Function ? await init(initCtx) : { ...init }
        const execute = toolInfo.execute
        toolInfo.execute = async (args, ctx) => {
          try {
            toolInfo.parameters.parse(args)
          } catch (error) {
            if (error instanceof z.ZodError && toolInfo.formatValidationError) {
              throw new Error(toolInfo.formatValidationError(error), { cause: error })
            }
            throw new Error(
              `The ${id} tool was called with invalid arguments: ${error}.\nPlease rewrite the input so it satisfies the expected schema.`,
              { cause: error },
            )
          }
          const result = await execute(args, ctx)
          // skip truncation for tools that handle it themselves
          if (result.metadata.truncated !== undefined) {
            return result
          }
          const truncated = await Truncate.output(result.output, {}, initCtx?.agent)
          return {
            ...result,
            output: truncated.content,
            metadata: {
              ...result.metadata,
              truncated: truncated.truncated,
              ...(truncated.truncated && { outputPath: truncated.outputPath }),
            },
          }
        }
        return toolInfo
      },
    }
  }
}
