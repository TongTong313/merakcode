import { Bus } from "../bus"
import { BusEvent } from "../bus/bus-event"
import { Identifier } from "@merakcode/util/id"
import { Instance } from "../project/instance"
import { Log } from "@merakcode/log/logger"
import z from "zod"

export namespace Question {
  const log = Log.create({ service: "question" })

  export const Option = z
    .object({
      label: z.string().describe("Display text (1-5 words, concise)"),
      description: z.string().describe("Explanation of choice"),
    })
    .meta({
      ref: "QuestionOption",
    })
  export type Option = z.infer<typeof Option>

  export const Info = z
    .object({
      question: z.string().describe("Complete question"),
      header: z.string().describe("Very short label (max 30 chars)"),
      options: z.array(Option).describe("Available choices"),
      multiple: z.boolean().optional().describe("Allow selecting multiple choices"),
      custom: z.boolean().optional().describe("Allow typing a custom answer (default: true)"),
      dismiss: z
        .boolean()
        .optional()
        .describe("Allow dismissing the prompt without selecting an option (default: true)"),
    })
    .meta({
      ref: "QuestionInfo",
    })
  export type Info = z.infer<typeof Info>

  export const Request = z
    .object({
      id: Identifier.schema("question"),
      sessionID: Identifier.schema("session"),
      /** Root session: a subagent's question belongs to the conversation it was started from, as permission requests do */
      root: Identifier.schema("session").optional(),
      questions: z.array(Info).describe("Questions to ask"),
      /**
       * Absolute timestamp (ms). When set, clients can show a countdown against Date.now(); on expiry the server
       * replies with empty answers.
       */
      expiresAt: z.number().optional(),
      tool: z
        .object({
          messageID: z.string(),
          callID: z.string(),
        })
        .optional(),
    })
    .meta({
      ref: "QuestionRequest",
    })
  export type Request = z.infer<typeof Request>

  export const Answer = z.array(z.string()).meta({
    ref: "QuestionAnswer",
  })
  export type Answer = z.infer<typeof Answer>

  export const Reply = z.object({
    answers: z
      .array(Answer)
      .describe("User answers in order of questions (each answer is an array of selected labels)"),
  })
  export type Reply = z.infer<typeof Reply>

  export const Event = {
    Asked: BusEvent.define("question.asked", Request),
    Replied: BusEvent.define(
      "question.replied",
      z.object({
        sessionID: z.string(),
        requestID: z.string(),
        answers: z.array(Answer),
      }),
    ),
    Rejected: BusEvent.define(
      "question.rejected",
      z.object({
        sessionID: z.string(),
        requestID: z.string(),
      }),
    ),
  }

  const state = Instance.state(async () => {
    const pending: Record<
      string,
      {
        info: Request
        resolve: (answers: Answer[]) => void
        reject: (e: any) => void
        timer?: ReturnType<typeof setTimeout>
      }
    > = {}

    return {
      pending,
    }
  })

  export async function ask(input: {
    sessionID: string
    /** Root session of a subagent's session (Session.rootID), so the question reaches the conversation that started it */
    root?: string
    questions: Info[]
    tool?: { messageID: string; callID: string }
    /** Expiry counts as unanswered and skips reply validation */
    timeoutMs?: number
    /** Aborting the session interrupts the pending question, rejects with AbortedError and clears it */
    abort?: AbortSignal
  }): Promise<Answer[]> {
    const s = await state()
    const id = Identifier.ascending("question")

    log.info("asking", { id, questions: input.questions.length })

    return new Promise<Answer[]>((resolve, reject) => {
      const expiresAt = input.timeoutMs !== undefined && input.timeoutMs > 0 ? Date.now() + input.timeoutMs : undefined
      const info: Request = {
        id,
        sessionID: input.sessionID,
        ...(input.root && input.root !== input.sessionID ? { root: input.root } : {}),
        questions: input.questions,
        tool: input.tool,
        ...(expiresAt !== undefined ? { expiresAt } : {}),
      }

      const finish = (fn: () => void) => {
        void (async () => {
          const s2 = await state()
          const cur = s2.pending[id]
          if (!cur) return
          if (cur.timer) {
            clearTimeout(cur.timer)
            delete cur.timer
          }
          delete s2.pending[id]
          fn()
        })()
      }

      const entry: (typeof s.pending)[string] = {
        info,
        resolve,
        reject,
      }

      if (expiresAt !== undefined && input.timeoutMs! > 0) {
        entry.timer = setTimeout(() => {
          finish(() => {
            const emptyAnswers = info.questions.map(() => [] as Answer)
            log.info("ask timeout", { requestID: id, sessionID: info.sessionID })
            Bus.publish(Event.Replied, {
              sessionID: info.sessionID,
              requestID: info.id,
              answers: emptyAnswers,
            })
            resolve(emptyAnswers)
          })
        }, input.timeoutMs)
      }

      const onAbort = () => {
        finish(() => {
          log.info("ask aborted", { requestID: id, sessionID: info.sessionID })
          Bus.publish(Event.Rejected, {
            sessionID: info.sessionID,
            requestID: info.id,
          })
          reject(new AbortedError())
        })
      }

      s.pending[id] = entry
      Bus.publish(Event.Asked, info)

      if (input.abort) {
        if (input.abort.aborted) {
          onAbort()
          return
        }
        input.abort.addEventListener("abort", onAbort, { once: true })
      }
    })
  }

  export class InvalidReplyError extends Error {
    constructor() {
      super("A required question needs a valid answer")
    }
  }

  export class NotDismissibleError extends Error {
    constructor() {
      super("This question cannot be dismissed")
    }
  }

  export class RequestNotFoundError extends Error {
    constructor() {
      super("Question request is no longer pending")
    }
  }

  /** Required questions need a real choice; an explicitly listed Skip option still counts as a valid answer. */
  export function validateReply(questions: Info[], answers: Answer[]): void {
    if (!questions.some((question) => question.dismiss === false)) return
    if (!Array.isArray(answers) || answers.length !== questions.length) throw new InvalidReplyError()
    for (const [index, question] of questions.entries()) {
      if (question.dismiss !== false) continue
      const answer = answers[index]
      if (!Array.isArray(answer) || answer.length === 0 || (!question.multiple && answer.length > 1))
        throw new InvalidReplyError()
      if (
        answer.some(
          (label) =>
            typeof label !== "string" ||
            !label.trim() ||
            (question.custom === false && !question.options.some((option) => option.label === label)),
        )
      )
        throw new InvalidReplyError()
    }
  }

  export async function reply(input: { requestID: string; answers: Answer[] }): Promise<boolean> {
    const s = await state()
    const existing = s.pending[input.requestID]
    if (!existing) {
      log.warn("reply for unknown request", { requestID: input.requestID })
      return false
    }
    validateReply(existing.info.questions, input.answers)
    if (existing.timer) {
      clearTimeout(existing.timer)
      delete existing.timer
    }
    delete s.pending[input.requestID]

    log.info("replied", { requestID: input.requestID, answers: input.answers })

    Bus.publish(Event.Replied, {
      sessionID: existing.info.sessionID,
      requestID: existing.info.id,
      answers: input.answers,
    })

    existing.resolve(input.answers)
    return true
  }

  export async function reject(requestID: string): Promise<boolean> {
    const s = await state()
    const existing = s.pending[requestID]
    if (!existing) {
      log.warn("reject for unknown request", { requestID })
      return false
    }
    if (existing.info.questions.some((question) => question.dismiss === false)) throw new NotDismissibleError()
    if (existing.timer) {
      clearTimeout(existing.timer)
      delete existing.timer
    }
    delete s.pending[requestID]

    log.info("rejected", { requestID })

    Bus.publish(Event.Rejected, {
      sessionID: existing.info.sessionID,
      requestID: existing.info.id,
    })

    existing.reject(new RejectedError())
    return true
  }

  export class RejectedError extends Error {
    constructor() {
      super("The user dismissed this question")
    }
  }

  /**
   * Clears a session's pending questions when the conversation stops: publishes question.rejected and rejects with
   * AbortedError. The question bar closes on the rejected event.
   */
  export async function abortPending(sessionID: string) {
    const s = await state()
    const pending = Object.values(s.pending).filter((item) => item.info.sessionID === sessionID)
    if (pending.length === 0) return
    log.info("abort pending", { sessionID, count: pending.length })
    for (const item of pending) {
      if (item.timer) {
        clearTimeout(item.timer)
        delete item.timer
      }
      delete s.pending[item.info.id]
      Bus.publish(Event.Rejected, {
        sessionID: item.info.sessionID,
        requestID: item.info.id,
      })
      item.reject(new AbortedError())
    }
  }

  /** A pending question interrupted by session.abort */
  export class AbortedError extends Error {
    constructor() {
      super("The question was aborted")
    }
  }

  export async function list() {
    return state().then((x) => Object.values(x.pending).map((x) => x.info))
  }
}
