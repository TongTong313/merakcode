import type { Message, Part } from "../client/gen/types.gen.js"
import { Locale } from "@merakcode/util/locale"
import { Text } from "@merakcode/util/text"

export type TranscriptOptions = {
  thinking: boolean
  toolDetails: boolean
  assistantMetadata: boolean
  /** Language of the labels in the exported markdown; defaults to Chinese */
  lang?: "zh" | "en"
}

export type SessionInfo = {
  id: string
  title: string
  time: {
    created: number
    updated: number
  }
}

export type MessageWithParts = {
  info: Message
  parts: Part[]
}

export function formatTranscript(
  session: SessionInfo,
  messages: MessageWithParts[],
  options: TranscriptOptions,
): string {
  const lang = options.lang ?? "zh"
  let transcript = `# ${session.title}\n\n`
  transcript += Text.format({ zh: "**会话 ID:** {id}\n", en: "**Session ID:** {id}\n" }, lang, { id: session.id })
  transcript += Text.format({ zh: "**创建时间:** {time}\n", en: "**Created:** {time}\n" }, lang, {
    time: new Date(session.time.created).toLocaleString(),
  })
  transcript += Text.format({ zh: "**更新时间:** {time}\n\n", en: "**Updated:** {time}\n\n" }, lang, {
    time: new Date(session.time.updated).toLocaleString(),
  })
  transcript += `---\n\n`

  for (const msg of messages) {
    transcript += formatMessage(msg.info, msg.parts, options)
    transcript += `---\n\n`
  }

  return transcript
}

export function formatMessage(msg: Message, parts: Part[], options: TranscriptOptions): string {
  const lang = options.lang ?? "zh"
  let result = ""

  if (msg.role === "user") {
    result += Text.format({ zh: "## 用户\n\n", en: "## User\n\n" }, lang)
  } else {
    result += formatAssistantHeader(msg, options.assistantMetadata, lang)
  }

  for (const part of parts) {
    result += formatPart(part, options)
  }

  return result
}

export function formatAssistantHeader(
  msg: Extract<Message, { role: "assistant" }>,
  includeMetadata: boolean,
  lang: TranscriptOptions["lang"] = "zh",
): string {
  const label = Text.format({ zh: "助手", en: "Assistant" }, lang)
  if (!("agent" in msg)) {
    const model = msg.execution.actualModel
    const name = model ? [model.providerID, model.id].filter(Boolean).join("/") : undefined
    return `## ${label} (${msg.execution.productTitle}${includeMetadata && name ? ` · ${name}` : ""})\n\n`
  }
  if (!includeMetadata) {
    return `## ${label}\n\n`
  }

  const duration =
    msg.time.completed && msg.time.created ? ((msg.time.completed - msg.time.created) / 1000).toFixed(1) + "s" : ""

  return `## ${label} (${Locale.titlecase(msg.agent)} · ${msg.modelID}${duration ? ` · ${duration}` : ""})\n\n`
}

export function formatPart(part: Part, options: TranscriptOptions): string {
  const lang = options.lang ?? "zh"
  const label = (text: Text.Pair) => Text.format(text, lang)

  if (part.type === "text" && !part.synthetic) {
    return `${part.text}\n\n`
  }

  if (part.type === "reasoning") {
    if (options.thinking) {
      return `_${label({ zh: "思考中", en: "Thinking" })}:_\n\n${part.text}\n\n`
    }
    return ""
  }

  if (part.type === "tool") {
    let result = `**${label({ zh: "工具", en: "Tool" })}: ${part.tool}**\n`
    if (options.toolDetails && part.state.input) {
      result += `\n**${label({ zh: "输入", en: "Input" })}:**\n\`\`\`json\n${JSON.stringify(part.state.input, null, 2)}\n\`\`\`\n`
    }
    if (options.toolDetails && part.state.status === "completed" && part.state.output) {
      result += `\n**${label({ zh: "输出", en: "Output" })}:**\n\`\`\`\n${part.state.output}\n\`\`\`\n`
    }
    if (options.toolDetails && part.state.status === "error" && part.state.error) {
      result += `\n**${label({ zh: "错误", en: "Error" })}:**\n\`\`\`\n${part.state.error}\n\`\`\`\n`
    }
    result += `\n`
    return result
  }

  return ""
}
