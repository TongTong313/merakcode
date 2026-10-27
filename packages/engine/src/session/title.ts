import { Log } from "@merakcode/log/logger"
import { Agent } from "../agent/agent"
import { Provider } from "../provider/provider"
import { Session } from "."
import { LLM } from "./llm"
import { Message } from "./message"

/**
 * Names a session after its first real user message with the hidden title agent. Shared by the native runner and
 * external conversations, which never enter the runner loop.
 */
export namespace SessionTitle {
  const log = Log.create({ service: "session.title" })

  /**
   * Model for the title request: the configured title agent model, then the small model of the provider that can
   * serve the conversation, then its regular model. Without a hint (external conversations have no native model) the
   * default model decides the provider; undefined means there is nothing to call.
   */
  async function resolveModel(agent: Agent.Info, hint?: { providerID: string; modelID: string }) {
    if (agent.model) return Provider.getModel(agent.model.providerID, agent.model.modelID)
    const fallback = hint ?? (await Provider.defaultModel().catch(() => undefined))
    if (!fallback) return undefined
    return (
      (await Provider.getSmallModel(fallback.providerID)) ??
      (await Provider.getModel(fallback.providerID, fallback.modelID))
    )
  }

  /** The stream takes a native user message; an external turn is described by a synthetic title request instead. */
  function requestUser(message: Message.FullMsg, model: Provider.Model): Message.UserInfo {
    const info = message.info
    if (info.role === "user" && !Message.isExternal(info)) return info
    return {
      id: info.id,
      sessionID: info.sessionID,
      role: "user",
      time: { created: info.time.created },
      agent: "title",
      model: { providerID: model.providerID, modelID: model.id },
    }
  }

  /**
   * Titles a session after its first real user message. Child sessions, renamed sessions and every later turn keep
   * their current title, and a failure leaves the default title in place.
   */
  export async function ensure(input: {
    session: Session.Info
    history: Message.FullMsg[]
    providerID?: string
    modelID?: string
  }) {
    if (input.session.parentID) return
    if (!Session.isDefaultTitle(input.session.title)) return

    // Find first non-synthetic user message
    const firstRealUserIdx = input.history.findIndex(
      (m) => m.info.role === "user" && !m.parts.every((p) => "synthetic" in p && p.synthetic),
    )
    if (firstRealUserIdx === -1) return

    const isFirst =
      input.history.filter((m) => m.info.role === "user" && !m.parts.every((p) => "synthetic" in p && p.synthetic))
        .length === 1
    if (!isFirst) return

    // Gather all messages up to and including the first real user message for context
    // This includes any shell/subtask executions that preceded the user's first prompt
    const contextMessages = input.history.slice(0, firstRealUserIdx + 1)
    const firstRealUser = contextMessages[firstRealUserIdx]

    // For subtask-only messages (from command invocations), extract the prompt directly
    // since toModelMessage converts subtask parts to generic "The following tool was executed by the user"
    const subtaskParts = firstRealUser.parts.filter((p) => p.type === "subtask") as Message.SubtaskPart[]
    const hasOnlySubtaskParts = subtaskParts.length > 0 && firstRealUser.parts.every((p) => p.type === "subtask")

    const agent = await Agent.get("title")
    if (!agent) return
    const hint =
      input.providerID && input.modelID ? { providerID: input.providerID, modelID: input.modelID } : undefined
    const model = await resolveModel(agent, hint)
    if (!model) return
    const result = await LLM.stream({
      agent,
      user: requestUser(firstRealUser, model),
      system: [],
      small: true,
      tools: {},
      model,
      abort: new AbortController().signal,
      sessionID: input.session.id,
      retries: 2,
      messages: [
        {
          role: "user",
          content: "Generate a title for this conversation:\n",
        },
        ...(hasOnlySubtaskParts
          ? [{ role: "user" as const, content: subtaskParts.map((p) => p.prompt).join("\n") }]
          : await Message.toModelMessages(contextMessages, model)),
      ],
    })
    const text = await Promise.resolve(result.text).catch((err) =>
      log.error("failed to generate title", { error: err }),
    )
    if (text)
      return Session.update(
        input.session.id,
        (draft) => {
          const cleaned = text
            .replace(/<think>[\s\S]*?<\/think>\s*/g, "")
            .split("\n")
            .map((line) => line.trim())
            .find((line) => line.length > 0)
          if (!cleaned) return

          const title = cleaned.length > 100 ? cleaned.substring(0, 97) + "..." : cleaned
          draft.title = title
        },
        { touch: false },
      )
  }
}
