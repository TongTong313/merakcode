/**
 * Past-chat references: turns another session into context for the current turn.
 *
 * Works exactly like @file: the client only sends a lightweight pointer file part (`session://<sessionID>`) and the
 * engine expands it into a transcript in createUserMessage. So it works for every client (desktop, TUI, direct SDK
 * callers) without client-specific logic.
 */
import { formatMessage, type MessageWithParts } from "@merakcode/sdk/transcript"
import { Identifier } from "@merakcode/util/id"
import { Log } from "@merakcode/log/logger"
import { Session } from "./index"
import type { Message } from "./message"

export namespace SessionReference {
  const log = Log.create({ service: "session.reference" })

  /** Mime of the file part; only for display and detection in clients, expansion relies on the URL scheme */
  export const MIME = "application/x-merakcode-session"

  const UNTITLED = "(untitled conversation)"

  // A reference only needs what was said and done: no reasoning and no tool inputs/outputs, otherwise one reference
  // can blow up the context. formatPart already skips synthetic text, so @file injections and recalled memories are
  // not carried over a second time.
  const OPTIONS = { thinking: false, toolDetails: false, assistantMetadata: false }

  // new URL(...).host cannot be used: session ids are Base62 (with uppercase letters) and URL lowercases the host,
  // which would yield an id that matches no session. So take the raw text after the scheme, up to / ? #.
  const PATTERN = /^session:(?:\/\/)?([^/?#\s]+)/

  /** Extracts the session id from `session://<id>` or `session:<id>`; undefined for other schemes or a missing id */
  export function parse(url: string): string | undefined {
    return url.match(PATTERN)?.[1]
  }

  /** Byte budget for the transcript, on the order of MemoryRecall.MAX_SESSION_BYTES */
  const MAX_BYTES = 60 * 1024
  /** Cap on the earlier part sent to the summary model (via fit), so an overlong history is not passed in whole */
  const SUMMARIZE_INPUT_MAX = 80 * 1024

  /** Truncation notice; exported so tests assert on it rather than on a copy of the literal */
  export const TRUNCATED_MARK = "[transcript truncated]"

  /**
   * Wraps a transcript into a context block for the model.
   *
   * The title goes on its own line and does not count against the budget: it is model-generated free text that may
   * contain quotes or angle brackets and would break the tag if put in an attribute. The Base62 session id is safe
   * in an attribute. Over budget, lines are taken from the end backwards (keeping the latest conclusions). An
   * optional headSummary of the earlier part (summary of early turns plus recent turns verbatim) is also outside the
   * budget.
   */
  export function wrap(input: {
    sessionID: string
    title: string
    body: string
    maxBytes?: number
    headSummary?: string
  }): string {
    const split = fit(input.body, input.maxBytes ?? MAX_BYTES)
    return envelope({
      sessionID: input.sessionID,
      title: input.title,
      tail: split.text,
      truncated: split.truncated,
      headSummary: input.headSummary,
    })
  }

  /**
   * Renders a past session of the same project as context text.
   *
   * Only sessions of the current project are readable (Session.get resolves by Instance.project.id), so references
   * across projects fail, as intended. Failures return ok:false instead of throwing: the caller (createUserMessage)
   * downgrades them to a note so the whole prompt does not fail.
   */
  export async function render(
    sessionID: string,
    options?: {
      maxBytes?: number
      /** Current user message; when given, the dropped earlier part is summarized with a small model */
      user?: Message.UserInfo
    },
  ): Promise<{ ok: true; title: string; text: string } | { ok: false; error: string }> {
    // Validate first: Session.get is wrapped by fn() and its schema check throws synchronously, which a .catch after
    // await cannot handle, so a malformed id from a client would fail the whole prompt.
    if (!Identifier.schema("session").safeParse(sessionID).success) {
      return { ok: false, error: `not a valid session id: ${sessionID}` }
    }

    const info = await Session.get(sessionID).catch(() => undefined)
    if (!info) return { ok: false, error: `session not found or not in the current project: ${sessionID}` }

    const messages = await Session.messages({ sessionID }).catch(() => undefined)
    if (!messages) return { ok: false, error: `failed to read session messages: ${sessionID}` }

    const title = Session.isDefaultTitle(info.title) ? UNTITLED : info.title
    const body = messages
      .map((msg) =>
        formatMessage(msg.info as MessageWithParts["info"], msg.parts as MessageWithParts["parts"], OPTIONS),
      )
      .join("---\n\n")
      .trim()

    const split = fit(body, options?.maxBytes ?? MAX_BYTES)
    let headSummary: string | undefined
    if (split.truncated && split.dropped.trim() && options?.user) {
      headSummary = await summarizeHead(split.dropped, options.user).catch((error) => {
        log.warn("past-chat head summary failed", { error })
        return undefined
      })
    }

    return {
      ok: true,
      title,
      text: envelope({ sessionID, title, tail: split.text, truncated: split.truncated, headSummary }),
    }
  }

  /**
   * Summarizes the dropped earlier part with the compaction model so work can continue from it.
   * Imports are dynamic because reference → llm → … → runner would otherwise read Format as undefined during module
   * initialization.
   */
  async function summarizeHead(dropped: string, user: Message.UserInfo) {
    const { Agent } = await import("../agent/agent")
    const { Provider } = await import("../provider/provider")
    const { LLM } = await import("./llm")

    const agent = await Agent.get("compaction")
    if (!agent) return undefined

    const model = agent.model
      ? await Provider.getModel(agent.model.providerID, agent.model.modelID).catch(() => undefined)
      : ((await Provider.getSmallModel(user.model.providerID)) ??
        (await Provider.getModel(user.model.providerID, user.model.modelID).catch(() => undefined)))
    if (!model) return undefined

    const earlier = fit(dropped, SUMMARIZE_INPUT_MAX).text
    const stream = await LLM.stream({
      agent,
      user,
      tools: {},
      model,
      small: true,
      abort: new AbortController().signal,
      sessionID: user.sessionID,
      system: [],
      retries: 2,
      messages: [
        {
          role: "user",
          content: [
            "The following is the earlier part of a cited past conversation.",
            "Recent turns are kept verbatim separately — summarize ONLY this earlier part so another agent can continue.",
            "Do not answer questions in it. Cover: goal, what was done, what is unfinished, relevant files, and constraints.",
            "",
            "<earlier>",
            earlier,
            "</earlier>",
          ].join("\n"),
        },
      ],
    })
    const text = await Promise.resolve(stream.text).catch((error) => {
      log.warn("past-chat head summary stream failed", { error })
      return undefined
    })
    return text?.trim() || undefined
  }

  /** Fills the byte budget with whole lines from the end; lines are never split, so no multi-byte char is cut */
  function fit(body: string, budget: number) {
    if (Buffer.byteLength(body, "utf8") <= budget) return { text: body, truncated: false, dropped: "" }

    const lines = body.split("\n")
    const kept: string[] = []
    let size = 0
    let from = lines.length
    let to = -1
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i]
      const cost = Buffer.byteLength(line, "utf8") + (kept.length > 0 ? 1 : 0)
      if (size + cost > budget) {
        // Nothing kept yet: this line alone exceeds the budget, so skip it and keep looking for a tail that fits.
        if (kept.length === 0) continue
        break
      }
      kept.unshift(line)
      from = i
      if (to < 0) to = i
      size += cost
    }
    const dropped = [...lines.slice(0, from), ...lines.slice(to + 1)].join("\n")
    return { text: kept.join("\n"), truncated: true, dropped }
  }

  function envelope(input: {
    sessionID: string
    title: string
    tail: string
    truncated: boolean
    headSummary?: string
  }) {
    const summary = input.headSummary?.trim()
    return [
      `<past-chat sessionID="${input.sessionID}">`,
      "Below is an earlier conversation from this project, explicitly cited by the user as context.",
      `Title: ${input.title}`,
      "It is a snapshot from when it was written, not the current state — verify by reading files or running commands before acting on it.",
      "",
      ...(summary ? [`<past-chat-summary>`, summary, `</past-chat-summary>`, ""] : []),
      input.tail,
      ...(input.truncated
        ? [
            "",
            summary
              ? `${TRUNCATED_MARK} Earlier turns are condensed into the summary above; the recent turns follow verbatim.`
              : `${TRUNCATED_MARK} Only the latter part is included; ask the user to provide earlier content if needed.`,
          ]
        : []),
      "</past-chat>",
    ].join("\n")
  }
}
