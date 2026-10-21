import { NamedError } from "@merakcode/util/error"
import { Network } from "@merakcode/util/network"
import { APICallError, convertToModelMessages, LoadAPIKeyError, type ModelMessage, type UIMessage } from "ai"
import z from "zod"

import { BusEvent } from "../bus/bus-event"
import { Identifier } from "@merakcode/util/id"
import { LSP } from "../lsp"
import { Snapshot } from "../snapshot"
import { fn } from "../util/fn"
import { Storage } from "../storage/storage"
import { ProviderError } from "../provider/error"
import type { Provider } from "../provider/provider"
import { PermissionMode } from "../permission/mode"
import { SessionToolResult } from "./tool-result"
import { Transcript } from "./transcript"

export namespace Message {
  export const OutputLengthError = NamedError.create("MessageOutputLengthError", z.object({}))
  export const AbortedError = NamedError.create("MessageAbortedError", z.object({ message: z.string() }))
  export const StructuredOutputError = NamedError.create(
    "StructuredOutputError",
    z.object({
      message: z.string(),
      retries: z.number(),
    }),
  )
  export const AuthError = NamedError.create(
    "ProviderAuthError",
    z.object({
      providerID: z.string(),
      message: z.string(),
    }),
  )
  export const APIError = NamedError.create(
    "APIError",
    z.object({
      message: z.string(),
      statusCode: z.number().optional(),
      isRetryable: z.boolean(),
      responseHeaders: z.record(z.string(), z.string()).optional(),
      responseBody: z.string().optional(),
      metadata: z.record(z.string(), z.string()).optional(),
    }),
  )
  export type APIError = z.infer<typeof APIError.Schema>
  export const ContextOverflowError = NamedError.create(
    "ContextOverflowError",
    z.object({ message: z.string(), responseBody: z.string().optional() }),
  )
  // Hard stop raised when auto-compaction has tripped its failure breaker and the context is still over capacity.
  // Unlike ContextOverflowError (a 413 from the provider), this is decided locally before the request. It tells the
  // user to run /compact or start a new session instead of repeatedly forking a summary agent that is bound to fail.
  export const CompactionBlockedError = NamedError.create(
    "CompactionBlockedError",
    z.object({
      message: z.string(),
      tokens: z.number().optional(), // current estimated tokens
      usable: z.number().optional(), // usable model capacity
    }),
  )
  // Product errors carry code, params and message for localized display
  const productErrorData = <T extends z.ZodRawShape>(extra: T) =>
    z.object({
      message: z.string(), // short English fallback text
      messageKey: z.string().optional(), // i18n key of the UI text
      params: z.record(z.string(), z.any()).optional(),
      ...extra,
    })

  export const ModelNotFoundError = NamedError.create(
    "ModelNotFoundError",
    productErrorData({
      providerID: z.string(),
      modelID: z.string(),
      suggestions: z.array(z.string()).optional(),
    }),
  )

  export const CommandNotFoundError = NamedError.create(
    "CommandNotFoundError",
    productErrorData({
      command: z.string(),
    }),
  )

  export const AgentNotFoundError = NamedError.create(
    "AgentNotFoundError",
    productErrorData({
      agent: z.string(),
      available: z.array(z.string()).optional(),
    }),
  )

  export const ConfigParseError = NamedError.create(
    "ConfigParseError",
    productErrorData({
      kind: z.enum(["command", "agent", "mode", "skill", "rule"]),
      path: z.string(),
      reason: z.string(),
    }),
  )

  export const PluginInstallError = NamedError.create(
    "PluginInstallError",
    productErrorData({
      package: z.string(),
      version: z.string(),
      reason: z.string(),
    }),
  )

  export const WorktreeResetDirtyError = NamedError.create(
    "WorktreeResetDirtyError",
    productErrorData({
      dirty: z.string(),
    }),
  )

  export const OutputFormatText = z
    .object({
      type: z.literal("text"),
    })
    .meta({
      ref: "OutputFormatText",
    })

  export const OutputFormatJsonSchema = z
    .object({
      type: z.literal("json_schema"),
      schema: z.record(z.string(), z.any()).meta({ ref: "JSONSchema" }),
      retryCount: z.number().int().min(0).default(2),
    })
    .meta({
      ref: "OutputFormatJsonSchema",
    })

  export const Format = z.discriminatedUnion("type", [OutputFormatText, OutputFormatJsonSchema]).meta({
    ref: "OutputFormat",
  })
  export type OutputFormat = z.infer<typeof Format>

  const PartBase = z.object({
    id: z.string(),
    sessionID: z.string(),
    messageID: z.string(),
  })

  export const SnapshotPart = PartBase.extend({
    type: z.literal("snapshot"),
    snapshot: z.string(),
  }).meta({
    ref: "SnapshotPart",
  })
  export type SnapshotPart = z.infer<typeof SnapshotPart>

  export const PatchPart = PartBase.extend({
    type: z.literal("patch"),
    backupID: z.string(),
    files: z.string().array(),
    additions: z.number().default(0),
    deletions: z.number().default(0),
  }).meta({
    ref: "PatchPart",
  })
  export type PatchPart = z.infer<typeof PatchPart>

  export const TextPart = PartBase.extend({
    type: z.literal("text"),
    text: z.string(),
    synthetic: z.boolean().optional(),
    ignored: z.boolean().optional(),
    time: z
      .object({
        start: z.number(),
        end: z.number().optional(),
      })
      .optional(),
    metadata: z.record(z.string(), z.any()).optional(),
  }).meta({
    ref: "TextPart",
  })
  export type TextPart = z.infer<typeof TextPart>

  export const ReasoningPart = PartBase.extend({
    type: z.literal("reasoning"),
    text: z.string(),
    metadata: z.record(z.string(), z.any()).optional(),
    time: z.object({
      start: z.number(),
      end: z.number().optional(),
    }),
  }).meta({
    ref: "ReasoningPart",
  })
  export type ReasoningPart = z.infer<typeof ReasoningPart>

  const FilePartSourceBase = z.object({
    text: z
      .object({
        value: z.string(),
        start: z.number().int(),
        end: z.number().int(),
      })
      .meta({
        ref: "FilePartSourceText",
      }),
  })

  export const FileSource = FilePartSourceBase.extend({
    type: z.literal("file"),
    path: z.string(),
  }).meta({
    ref: "FileSource",
  })

  export const SymbolSource = FilePartSourceBase.extend({
    type: z.literal("symbol"),
    path: z.string(),
    range: LSP.Range,
    name: z.string(),
    kind: z.number().int(),
  }).meta({
    ref: "SymbolSource",
  })

  export const ResourceSource = FilePartSourceBase.extend({
    type: z.literal("resource"),
    clientName: z.string(),
    uri: z.string(),
  }).meta({
    ref: "ResourceSource",
  })

  export const FilePartSource = z.discriminatedUnion("type", [FileSource, SymbolSource, ResourceSource]).meta({
    ref: "FilePartSource",
  })

  export const FilePart = PartBase.extend({
    type: z.literal("file"),
    mime: z.string(),
    filename: z.string().optional(),
    url: z.string(),
    source: FilePartSource.optional(),
  }).meta({
    ref: "FilePart",
  })
  export type FilePart = z.infer<typeof FilePart>

  export const AgentPart = PartBase.extend({
    type: z.literal("agent"),
    name: z.string(),
    source: z
      .object({
        value: z.string(),
        start: z.number().int(),
        end: z.number().int(),
      })
      .optional(),
  }).meta({
    ref: "AgentPart",
  })
  export type AgentPart = z.infer<typeof AgentPart>

  export const CompactionPart = PartBase.extend({
    type: z.literal("compaction"),
    auto: z.boolean(),
    // Continuing after auto-compaction must keep the permission mode from before compaction.
    permissionMode: PermissionMode.Schema.optional(),
    // Deferred tools activated before compaction. After compaction, scanActivatedTools restores them from the compact
    // boundary so they do not fall back to deferred once their history is compacted. Only names are stored; older
    // parts without this field are skipped.
    preCompactActivatedTools: z.array(z.string()).optional(),
  }).meta({
    ref: "CompactionPart",
  })
  export type CompactionPart = z.infer<typeof CompactionPart>

  export const SubtaskPart = PartBase.extend({
    type: z.literal("subtask"),
    prompt: z.string(),
    description: z.string(),
    agent: z.string(),
    model: z
      .object({
        providerID: z.string(),
        modelID: z.string(),
      })
      .optional(),
    command: z.string().optional(),
  }).meta({
    ref: "SubtaskPart",
  })
  export type SubtaskPart = z.infer<typeof SubtaskPart>

  export const RetryPart = PartBase.extend({
    type: z.literal("retry"),
    attempt: z.number(),
    error: APIError.Schema,
    time: z.object({
      created: z.number(),
    }),
  }).meta({
    ref: "RetryPart",
  })
  export type RetryPart = z.infer<typeof RetryPart>

  export const StepStartPart = PartBase.extend({
    type: z.literal("step-start"),
    snapshot: z.string().optional(),
  }).meta({
    ref: "StepStartPart",
  })
  export type StepStartPart = z.infer<typeof StepStartPart>

  export const StepFinishPart = PartBase.extend({
    type: z.literal("step-finish"),
    reason: z.string(),
    snapshot: z.string().optional(),
    cost: z.number(),
    tokens: z.object({
      total: z.number().optional(),
      input: z.number(),
      output: z.number(),
      reasoning: z.number(),
      cache: z.object({
        read: z.number(),
        write: z.number(),
      }),
    }),
  }).meta({
    ref: "StepFinishPart",
  })
  export type StepFinishPart = z.infer<typeof StepFinishPart>

  export const ToolStatePending = z
    .object({
      status: z.literal("pending"),
      input: z.record(z.string(), z.any()),
      raw: z.string(),
    })
    .meta({
      ref: "ToolStatePending",
    })

  export type ToolStatePending = z.infer<typeof ToolStatePending>

  export const ToolStateRunning = z
    .object({
      status: z.literal("running"),
      input: z.record(z.string(), z.any()),
      title: z.string().optional(),
      metadata: z.record(z.string(), z.any()).optional(),
      time: z.object({
        start: z.number(),
      }),
    })
    .meta({
      ref: "ToolStateRunning",
    })
  export type ToolStateRunning = z.infer<typeof ToolStateRunning>

  export const ToolErrorKind = z.enum(["permission_rejected", "timeout", "execution", "invalid_arguments"])
  export type ToolErrorKind = z.infer<typeof ToolErrorKind>

  export const ToolCompletedMetadata = z
    .object({
      mcpIsError: z.boolean().optional(),
    })
    .catchall(z.any())
  export const ToolErrorMetadata = z
    .object({
      errorKind: ToolErrorKind.optional(),
    })
    .catchall(z.any())

  export const ToolStateCompleted = z
    .object({
      status: z.literal("completed"),
      input: z.record(z.string(), z.any()),
      output: z.string(),
      title: z.string(),
      metadata: ToolCompletedMetadata,
      time: z.object({
        start: z.number(),
        end: z.number(),
        compacted: z.number().optional(),
      }),
      attachments: FilePart.array().optional(),
    })
    .meta({
      ref: "ToolStateCompleted",
    })
  export type ToolStateCompleted = z.infer<typeof ToolStateCompleted>

  export const ToolStateError = z
    .object({
      status: z.literal("error"),
      input: z.record(z.string(), z.any()),
      error: z.string(),
      metadata: ToolErrorMetadata.optional(),
      time: z.object({
        start: z.number(),
        end: z.number(),
      }),
    })
    .meta({
      ref: "ToolStateError",
    })
  export type ToolStateError = z.infer<typeof ToolStateError>

  export const ToolState = z
    .discriminatedUnion("status", [ToolStatePending, ToolStateRunning, ToolStateCompleted, ToolStateError])
    .meta({
      ref: "ToolState",
    })

  export const ToolPart = PartBase.extend({
    type: z.literal("tool"),
    callID: z.string(),
    tool: z.string(),
    state: ToolState,
    metadata: z.record(z.string(), z.any()).optional(),
  }).meta({
    ref: "ToolPart",
  })
  export type ToolPart = z.infer<typeof ToolPart>

  const Base = z.object({
    id: z.string(),
    sessionID: z.string(),
    /**
     * Free-form message metadata; the engine does not interpret it.
     *
     * Written by:
     *   - user messages: the `chat.message` hook output, or the caller directly in the prompt/command request body
     */
    metadata: z.record(z.string(), z.unknown()).optional(),
  })

  export const UserInfo = Base.extend({
    role: z.literal("user"),
    time: z.object({
      created: z.number(),
    }),
    format: Format.optional(),
    summary: z
      .object({
        title: z.string().optional(),
        body: z.string().optional(),
        diffs: Snapshot.FileDiff.array(),
      })
      .optional(),
    agent: z.string(),
    permissionMode: PermissionMode.Schema.optional(),
    model: z.object({
      providerID: z.string(),
      modelID: z.string(),
    }),
    system: z.string().optional(),
    /** Source IDs written internally by command(); public prompt requests cannot set this. */
    commandSource: z.object({ templatePartIDs: z.array(z.string()) }).optional(),
    tools: z.record(z.string(), z.boolean()).optional(),
    variant: z.string().optional(),
  }).meta({
    ref: "UserMessage",
  })
  export type UserInfo = z.infer<typeof UserInfo>

  export const Part = z
    .discriminatedUnion("type", [
      TextPart,
      SubtaskPart,
      ReasoningPart,
      FilePart,
      ToolPart,
      StepStartPart,
      StepFinishPart,
      SnapshotPart,
      PatchPart,
      AgentPart,
      RetryPart,
      CompactionPart,
    ])
    .meta({
      ref: "Part",
    })
  export type Part = z.infer<typeof Part>

  export const AssistantInfo = Base.extend({
    role: z.literal("assistant"),
    time: z.object({
      created: z.number(),
      completed: z.number().optional(),
    }),
    error: z
      .discriminatedUnion("name", [
        AuthError.Schema,
        NamedError.Unknown.Schema,
        OutputLengthError.Schema,
        AbortedError.Schema,
        StructuredOutputError.Schema,
        ContextOverflowError.Schema,
        CompactionBlockedError.Schema,
        APIError.Schema,
        ModelNotFoundError.Schema,
        CommandNotFoundError.Schema,
        AgentNotFoundError.Schema,
        ConfigParseError.Schema,
        PluginInstallError.Schema,
        WorktreeResetDirtyError.Schema,
      ])
      .optional(),
    parentID: z.string(),
    modelID: z.string(),
    providerID: z.string(),
    /**
     * @deprecated
     */
    mode: z.string(),
    agent: z.string(),
    path: z.object({
      cwd: z.string(),
      root: z.string(),
    }),
    summary: z.boolean().optional(),
    cost: z.number(),
    tokens: z.object({
      total: z.number().optional(),
      input: z.number(),
      output: z.number(),
      reasoning: z.number(),
      cache: z.object({
        read: z.number(),
        write: z.number(),
      }),
    }),
    // Context breakdown by source, in characters; clients scale the shares by the real input tokens for display.
    // Optional for compatibility: when it is missing (older messages or engines), clients show only the total.
    contextBreakdown: z
      .object({
        systemBase: z.number(),
        environment: z.number(),
        rules: z.number(),
        toolDefinitions: z.number(),
        mcp: z.number(),
        skills: z.number(),
        subagents: z.number(),
        conversation: z.number(),
        total: z.number(),
      })
      .optional(),
    structured: z.any().optional(),
    variant: z.string().optional(),
    finish: z.string().optional(),
  }).meta({
    ref: "AssistantMessage",
  })
  export type AssistantInfo = z.infer<typeof AssistantInfo>

  export const Info = z.discriminatedUnion("role", [UserInfo, AssistantInfo]).meta({
    ref: "Message",
  })
  export type Info = z.infer<typeof Info>

  export const Event = {
    Updated: BusEvent.define(
      "message.updated",
      z.object({
        // Always equals info.sessionID; matches the opencode 1.16.2 event shape (see Session.Event).
        // Required so a publisher that omits it fails typecheck.
        sessionID: z.string(),
        info: Info,
      }),
    ),
    Removed: BusEvent.define(
      "message.removed",
      z.object({
        sessionID: z.string(),
        messageID: z.string(),
      }),
    ),
    PartUpdated: BusEvent.define(
      "message.part.updated",
      z.object({
        part: Part,
        delta: z.string().optional(),
      }),
    ),
    PartRemoved: BusEvent.define(
      "message.part.removed",
      z.object({
        sessionID: z.string(),
        messageID: z.string(),
        partID: z.string(),
      }),
    ),
  }

  export const FullMsg = z.object({
    info: Info,
    parts: z.array(Part),
  })
  export type FullMsg = z.infer<typeof FullMsg>

  /**
   * For command messages, returns the expanded template (including subtask prompts) selected by source ID, so safety
   * policies can see the user's intent.
   */
  export function userSourceTexts(message: FullMsg): string[] {
    if (message.info.role !== "user") return []
    const source = message.info.commandSource
    if (source) {
      const template = source.templatePartIDs
        .flatMap((id) => {
          const part = message.parts.find((item) => item.id === id)
          if (part?.type === "text") return [part.text]
          if (part?.type === "subtask") return [part.prompt]
          return []
        })
        .join("\n")
      return template.trim() ? [template] : []
    }
    const text = message.parts
      .filter((part): part is TextPart => part.type === "text" && !part.ignored && !part.synthetic)
      .map((part) => part.text)
      .join("\n")
    return text.trim() ? [text] : []
  }

  /**
   * Text used for retrieval, memory and task extraction: the command template the model actually ran, or the user's
   * own text for ordinary messages.
   */
  export function userTaskText(message: FullMsg): string {
    const texts = userSourceTexts(message)
    return message.info.role === "user" && message.info.commandSource ? (texts.at(-1) ?? "") : (texts[0] ?? "")
  }

  /** Placeholder result for a dangling tool_use (Anthropic requires a tool_result for every tool_use). */
  const INTERRUPTED_TEXT = "[Tool execution was interrupted]"

  // Only the fields we need, so session does not depend on workflow (no WorkflowRunMetadata import)
  type WorkflowMetaView = { status?: string; workflowName?: string; runId?: string }

  export type InterruptedToolResult =
    | { kind: "workflow-running"; output: string }
    | { kind: "workflow-terminal"; output: string }
    | { kind: "interrupted"; errorText: string }

  /**
   * Decides which of three results to send the LLM for a pending or running tool part.
   *
   * Only parts that are definitely not running in the background (not workflow_run, pending, or no metadata) are
   * reported as interrupted. A detached workflow_run (metadata present) always gets a normal, non-error tool result
   * saying it is still running or already finished and its work must not be repeated.
   *
   * Coupled with two other places; change them together:
   * - processor.ts skips workflow_run when finalizing a turn and does not mark it as error, so it stays running;
   * - runner.ts ctx.metadata keeps writing background metadata (possibly terminal) while the part is running, with
   *   the part status pinned to "running", so part.state=running with a terminal metadata.status is a stable state.
   * The terminal branch must therefore never fall back to interrupted, or finished workflows would be reported as
   * interrupted.
   */
  function resolveInterruptedToolResult(part: ToolPart): InterruptedToolResult {
    if (part.tool !== "workflow_run") return { kind: "interrupted", errorText: INTERRUPTED_TEXT }
    // pending has no metadata (not detached yet); only running does, so narrow first
    if (part.state.status !== "running") return { kind: "interrupted", errorText: INTERRUPTED_TEXT }
    const meta = part.state.metadata as WorkflowMetaView | undefined
    // Running without initial metadata means the background run never really started; treat it as interrupted
    if (!meta || !meta.status) return { kind: "interrupted", errorText: INTERRUPTED_TEXT }
    const id = [meta.workflowName && `"${meta.workflowName}"`, meta.runId && `(run ${meta.runId})`]
      .filter(Boolean)
      .join(" ")
    if (meta.status === "running") {
      // WorkflowRunStatus has no paused state, so running means still executing
      return {
        kind: "workflow-running",
        output: [
          `[workflow_run ${id} — STATUS: RUNNING, NOT COMPLETE. This is NOT the workflow result.]`,
          `The workflow is still executing in the background and has produced no result yet; it was not stopped.`,
          `When it reaches a terminal status you will receive a separate "workflow.finished" system notification carrying the outcome.`,
          `Do not redo its work, do not treat it as stopped or failed, and do not call workflow_run again for this run. End your turn now and wait for that notification.`,
        ].join("\n"),
      }
    }
    // Metadata present and not running means terminal (completed/failed/aborted); the result arrives via notification
    return {
      kind: "workflow-terminal",
      output: [
        `[workflow_run ${id} has already reached terminal status "${meta.status}".]`,
        `Its outcome was delivered via a separate "workflow.finished" system notification. Do not redo its work and do not call workflow_run again for this run unless the user explicitly asks.`,
      ].join("\n"),
    }
  }

  export const __test = { resolveInterruptedToolResult }

  export async function toModelMessages(input: FullMsg[], model: Provider.Model): Promise<ModelMessage[]> {
    const result: UIMessage[] = []
    const toolNames = new Set<string>()
    // Track media from tool results that need to be injected as user messages
    // for providers that don't support media in tool results.
    //
    // OpenAI-compatible APIs only support string content in tool results, so we need
    // to extract media and inject as user messages. Anthropic and Google handle media
    // parts in tool results directly.
    //
    // Only apply this workaround if the model actually supports image input -
    // otherwise there's no point extracting images.
    const supportsMediaInToolResults = (() => {
      if (model.api.npm === "@ai-sdk/anthropic") return true
      if (model.api.npm === "@ai-sdk/openai") return true
      if (model.api.npm === "@ai-sdk/google") {
        const id = model.api.id.toLowerCase()
        return id.includes("gemini-3") && !id.includes("gemini-2")
      }
      return false
    })()

    const toModelOutput = ({ output }: { output: unknown }) => {
      if (typeof output === "string") {
        return { type: "text", value: output }
      }

      if (typeof output === "object") {
        const outputObject = output as {
          text: string
          attachments?: Array<{ mime: string; url: string }>
        }
        const attachments = (outputObject.attachments ?? []).filter((attachment) => {
          return attachment.url.startsWith("data:") && attachment.url.includes(",")
        })

        return {
          type: "content",
          value: [
            { type: "text", text: outputObject.text },
            ...attachments.map((attachment) => ({
              type: "file",
              mediaType: attachment.mime,
              data: { type: "data", data: attachment.url.slice(attachment.url.indexOf(",") + 1) },
            })),
          ],
        }
      }

      return { type: "json", value: output as never }
    }

    for (const msg of input) {
      if (msg.parts.length === 0) continue

      if (msg.info.role === "user") {
        // UIMessage is converted to ModelMessage by the AI SDK, which handles provider protocol differences
        const userMessage: UIMessage = {
          id: msg.info.id,
          role: "user",
          parts: [],
        }
        result.push(userMessage)
        for (const part of msg.parts) {
          if (part.type === "text" && !part.ignored)
            userMessage.parts.push({
              type: "text",
              text: part.text,
            })
          // File parts already expanded into synthetic text (text/plain, directories, session references) are not sent
          // again. SessionReference cannot be imported statically because of a cycle with runner.
          if (
            part.type === "file" &&
            part.mime !== "text/plain" &&
            part.mime !== "application/x-directory" &&
            part.mime !== "application/x-merakcode-session"
          )
            userMessage.parts.push({
              type: "file",
              url: part.url,
              mediaType: part.mime,
              filename: part.filename,
            })

          if (part.type === "compaction") {
            userMessage.parts.push({
              type: "text",
              text: "What did we do so far?",
            })
          }
          if (part.type === "subtask") {
            userMessage.parts.push({
              type: "text",
              text: "The following tool was executed by the user",
            })
          }
        }
      }

      if (msg.info.role === "assistant") {
        const differentModel = `${model.providerID}/${model.id}` !== `${msg.info.providerID}/${msg.info.modelID}`
        const media: Array<{ mime: string; url: string }> = []

        if (
          msg.info.error &&
          !(
            Message.AbortedError.isInstance(msg.info.error) &&
            msg.parts.some((part) => part.type !== "step-start" && part.type !== "reasoning")
          )
        ) {
          continue
        }
        const assistantMessage: UIMessage = {
          id: msg.info.id,
          role: "assistant",
          parts: [],
        }
        for (const part of msg.parts) {
          if (part.type === "text" && !part.ignored)
            assistantMessage.parts.push({
              type: "text",
              text: part.text,
              ...(differentModel ? {} : { providerMetadata: part.metadata }),
            })
          if (part.type === "step-start")
            assistantMessage.parts.push({
              type: "step-start",
            })
          if (part.type === "tool") {
            toolNames.add(part.tool)
            if (part.state.status === "completed") {
              const outputText = part.state.time.compacted ? SessionToolResult.PLACEHOLDER : part.state.output
              const attachments = part.state.time.compacted ? [] : (part.state.attachments ?? [])

              // For providers that don't support media in tool results, extract media files
              // (images, PDFs) to be sent as a separate user message
              const isMediaAttachment = (a: { mime: string }) =>
                a.mime.startsWith("image/") || a.mime === "application/pdf"
              const mediaAttachments = attachments.filter(isMediaAttachment)
              const nonMediaAttachments = attachments.filter((a) => !isMediaAttachment(a))
              if (!supportsMediaInToolResults && mediaAttachments.length > 0) {
                media.push(...mediaAttachments)
              }
              const finalAttachments = supportsMediaInToolResults ? attachments : nonMediaAttachments

              const output =
                finalAttachments.length > 0
                  ? {
                      text: outputText,
                      attachments: finalAttachments,
                    }
                  : outputText

              assistantMessage.parts.push({
                type: ("tool-" + part.tool) as `tool-${string}`,
                state: "output-available",
                toolCallId: part.callID,
                input: part.state.input,
                output,
                ...(differentModel ? {} : { callProviderMetadata: part.metadata }),
              })
            }
            if (part.state.status === "error")
              assistantMessage.parts.push({
                type: ("tool-" + part.tool) as `tool-${string}`,
                state: "output-error",
                toolCallId: part.callID,
                input: part.state.input,
                errorText: part.state.error,
                ...(differentModel ? {} : { callProviderMetadata: part.metadata }),
              })
            // Handle pending/running tool calls to prevent dangling tool_use blocks
            // Anthropic/Claude APIs require every tool_use to have a corresponding tool_result.
            // workflow_run is special-cased in resolveInterruptedToolResult; see the coupling notes there.
            if (part.state.status === "pending" || part.state.status === "running") {
              const decision = resolveInterruptedToolResult(part)
              assistantMessage.parts.push(
                decision.kind === "interrupted"
                  ? {
                      type: ("tool-" + part.tool) as `tool-${string}`,
                      state: "output-error",
                      toolCallId: part.callID,
                      input: part.state.input,
                      errorText: decision.errorText,
                      ...(differentModel ? {} : { callProviderMetadata: part.metadata }),
                    }
                  : {
                      // Detached workflow_run: a normal result, so the model does not assume an interrupt and redo it
                      type: ("tool-" + part.tool) as `tool-${string}`,
                      state: "output-available",
                      toolCallId: part.callID,
                      input: part.state.input,
                      output: decision.output,
                      ...(differentModel ? {} : { callProviderMetadata: part.metadata }),
                    },
              )
            }
          }
          if (part.type === "reasoning") {
            assistantMessage.parts.push({
              type: "reasoning",
              text: part.text,
              ...(differentModel ? {} : { providerMetadata: part.metadata }),
            })
          }
        }
        if (assistantMessage.parts.length > 0) {
          result.push(assistantMessage)
          // Inject pending media as a user message for providers that don't support
          // media (images, PDFs) in tool results
          if (media.length > 0) {
            result.push({
              id: Identifier.ascending("message"),
              role: "user",
              parts: [
                {
                  type: "text" as const,
                  text: "Attached image(s) from tool result:",
                },
                ...media.map((attachment) => ({
                  type: "file" as const,
                  url: attachment.url,
                  mediaType: attachment.mime,
                })),
              ],
            })
          }
        }
      }
    }

    const tools = Object.fromEntries(Array.from(toolNames).map((toolName) => [toolName, { toModelOutput }]))

    return convertToModelMessages(
      result.filter((msg) => msg.parts.some((part) => part.type !== "step-start")),
      {
        //@ts-expect-error (convertToModelMessages expects a ToolSet but only actually needs tools[name]?.toModelOutput)
        tools,
      },
    )
  }

  /** Yields all session messages by descending ID (newest first); storage lives in session/transcript.ts */
  export const stream = fn(Identifier.schema("session"), async function* (sessionID) {
    yield* Transcript.reverse(sessionID)
  })

  export const parts = fn(
    z.object({
      sessionID: Identifier.schema("session"),
      messageID: Identifier.schema("message"),
    }),
    (input) => Transcript.parts(input.sessionID, input.messageID),
  )

  export const get = fn(
    z.object({
      sessionID: Identifier.schema("session"),
      messageID: Identifier.schema("message"),
    }),
    async (input): Promise<FullMsg> => {
      const found = await Transcript.message(input.sessionID, input.messageID)
      if (!found) throw new Storage.NotFoundError({ message: `Resource not found: message ${input.messageID}` })
      return found
    },
  )

  /**
   * Read-time compatibility: maps the old shape of user message summary.diffs to the current one. Applied to
   * Transcript replay output and before import-full validation; only the returned value changes, nothing is written.
   */
  export function legacy(info: Message.Info): Message.Info {
    if (info.role === "user") {
      const diffs = info.summary?.diffs
      if (!Array.isArray(diffs) || diffs.every((item) => legacyDiff(item) === item)) return info
      return { ...info, summary: { ...info.summary!, diffs: diffs.map(legacyDiff) } }
    }
    return info
  }

  /**
   * opencode (>=1.2) `SnapshotFileDiff` is `{ file?, patch?, additions, deletions, status? }`, while this engine
   * requires `file/before/after`. It appears in `summary.diffs` of user messages and sessions; missing content becomes
   * an empty string and `patch` is kept as is.
   */
  export function legacyDiff(diff: Snapshot.FileDiff): Snapshot.FileDiff {
    const raw = diff as Partial<Snapshot.FileDiff>
    if (typeof raw.file === "string" && typeof raw.before === "string" && typeof raw.after === "string") return diff
    return { ...diff, file: raw.file ?? "", before: raw.before ?? "", after: raw.after ?? "" }
  }

  /**
   * opencode `PatchPart` is `{ hash, files }` and has no file backup. An empty `backupID` means no backup and no
   * per-file undo, the same as `Snapshot.track()` returns with snapshots disabled; undo then only logs
   * backup not found and leaves files untouched.
   */
  export function legacyPart(part: Message.Part): Message.Part {
    if (part.type !== "patch" || typeof part.backupID === "string") return part
    return { ...part, backupID: "", additions: part.additions ?? 0, deletions: part.deletions ?? 0 }
  }

  export async function filterCompacted(stream: AsyncIterable<Message.FullMsg>) {
    const result = [] as Message.FullMsg[]
    const completed = new Set<string>()
    for await (const msg of stream) {
      result.push(msg)
      if (
        msg.info.role === "user" &&
        completed.has(msg.info.id) &&
        msg.parts.some((part) => part.type === "compaction")
      )
        break
      if (msg.info.role === "assistant" && msg.info.summary && msg.info.finish && !msg.info.error)
        completed.add(msg.info.parentID)
    }
    result.reverse()
    return result
  }

  // Detects aborts wrapped by the AI SDK: walks the error and its cause chain for AbortError or MessageAbortedError,
  // covering wrapped aborts not triggered directly by input.abort.
  function isAbortLike(e: unknown): boolean {
    let cur: any = e
    for (let i = 0; cur && i < 5; i++, cur = cur.cause) {
      if (cur?.name === "AbortError" || cur?.name === "MessageAbortedError") return true
    }
    return false
  }

  // Provider.ModelNotFoundError / ProviderAccessDeniedError are thrown by getModel/getSDK when the provider is missing.
  // Provider cannot be imported statically (cycle), so match on name and data shape. The Message schema requires
  // message but the Provider error may lack it, so the target schema cannot be used with safeParse.
  function isProviderModelNotFoundError(e: unknown): e is Error & { data: { providerID: string; modelID: string } } {
    return (
      e instanceof Error &&
      e.name === "ProviderModelNotFoundError" &&
      typeof (e as any).data?.providerID === "string" &&
      typeof (e as any).data?.modelID === "string"
    )
  }

  export function fromError(e: unknown, ctx: { providerID: string }) {
    switch (true) {
      case e instanceof DOMException && e.name === "AbortError":
        return new Message.AbortedError(
          { message: e.message },
          {
            cause: e,
          },
        ).toObject()
      // Fallback: an AbortError on the error or its cause chain becomes a standard MessageAbortedError
      case isAbortLike(e):
        return new Message.AbortedError({ message: "Operation aborted" }, { cause: e as Error }).toObject()
      case Message.OutputLengthError.isInstance(e):
        return e
      case LoadAPIKeyError.isInstance(e):
        return new Message.AuthError(
          {
            providerID: ctx.providerID,
            message: e.message,
          },
          { cause: e },
        ).toObject()
      // Same display as runner publishProviderError, instead of falling back to the class name
      case isProviderModelNotFoundError(e):
        return new Message.ModelNotFoundError(
          {
            providerID: e.data.providerID,
            modelID: e.data.modelID,
            messageKey: "error.modelNotFound",
            params: {
              provider: e.data.providerID,
              model: e.data.modelID,
              suggestions: (e.data as { suggestions?: string[] }).suggestions?.join(", ") ?? "",
            },
            message: `Model not found: ${e.data.providerID}/${e.data.modelID}`,
          },
          { cause: e },
        ).toObject()
      // Connection dropped mid-request (fetch "terminated", cause UND_ERR_SOCKET / ECONNRESET): retryable
      case Network.failure(e) === "reset": {
        const error = e as NodeJS.ErrnoException
        const cause = error.cause as NodeJS.ErrnoException | undefined
        return new Message.APIError(
          {
            message: "Connection reset by server",
            isRetryable: true,
            metadata: {
              code: error.code ?? cause?.code ?? "",
              syscall: error.syscall ?? cause?.syscall ?? "",
              message: cause?.message ? `${error.message}: ${cause.message}` : (error.message ?? ""),
            },
          },
          { cause: e },
        ).toObject()
      }
      // Unreachable ("fetch failed", details in cause); the two message checks match the Chinese and English versions
      // of the Provider connection error text
      case Network.failure(e) === "unreachable" ||
        (e instanceof Error && (e.message.includes("无法连接到") || e.message.startsWith("Unable to connect to"))): {
        const error = e as Error
        const cause = error.cause instanceof Error ? error.cause.message : undefined
        return new Message.APIError(
          {
            message: error.message === "fetch failed" && cause ? cause : error.message,
            isRetryable: true,
          },
          { cause: e },
        ).toObject()
      }
      case APICallError.isInstance(e):
        const parsed = ProviderError.parseAPICallError({
          providerID: ctx.providerID,
          error: e,
        })
        if (parsed.type === "context_overflow") {
          return new Message.ContextOverflowError(
            {
              message: parsed.message,
              responseBody: parsed.responseBody,
            },
            { cause: e },
          ).toObject()
        }

        return new Message.APIError(
          {
            message: parsed.message,
            statusCode: parsed.statusCode,
            isRetryable: parsed.isRetryable,
            responseHeaders: parsed.responseHeaders,
            responseBody: parsed.responseBody,
            metadata: parsed.metadata,
          },
          { cause: e },
        ).toObject()
      case e instanceof Error:
        return new NamedError.Unknown({ message: e.toString() }, { cause: e }).toObject()
      default:
        try {
          const parsed = ProviderError.parseStreamError(e)
          if (parsed) {
            if (parsed.type === "context_overflow") {
              return new Message.ContextOverflowError(
                {
                  message: parsed.message,
                  responseBody: parsed.responseBody,
                },
                { cause: e },
              ).toObject()
            }
            return new Message.APIError(
              {
                message: parsed.message,
                isRetryable: parsed.isRetryable,
                responseBody: parsed.responseBody,
              },
              {
                cause: e,
              },
            ).toObject()
          }
        } catch {}
        return new NamedError.Unknown({ message: JSON.stringify(e) }, { cause: e }).toObject()
    }
  }
}
