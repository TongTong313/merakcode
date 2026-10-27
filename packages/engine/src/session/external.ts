import { randomUUID } from "node:crypto"
import { Identifier } from "@merakcode/util/id"
import { Session } from "."
import { Message } from "./message"
import { SessionExecution } from "./execution"
import type { SessionRunner } from "./runner"
import { Instance } from "../project/instance"
import { Storage } from "../storage/storage"
import { configuredProducts } from "../agent-connection/catalog"
import { adapterOf } from "../agent-connection/adapters"
import { runExternal, settleExternal, decideExternal } from "../agent-connection/runtime"
import { withProduct, productState, onDisable } from "../agent-connection/state"
import { SessionTarget } from "./target"
import { ExternalAdapterError, ExternalBlockedError } from "./external-error"
import { Question } from "../question"
import { runAdmitted } from "../collaboration/schedule"
import { Text } from "../util/text"
import { Lock } from "../util/lock"

export namespace ExternalSession {
  type Binding = { productID: string; resumeID?: string; contextMode: "resume" | "replay" }
  const queues = new Map<string, Promise<void>>()
  const pending = new Map<
    string,
    { ownerID?: string; sessionID: string; productID: string; controller: AbortController; done: Promise<void> }
  >()
  const recovered = new Set<string>()
  onDisable((productID) => {
    for (const run of pending.values())
      if (run.productID === productID) run.controller.abort(new DOMException("The product was disabled", "AbortError"))
  })

  export async function settle(sessionID: string) {
    await Promise.all([...pending.values()].filter((run) => run.sessionID === sessionID).map((run) => run.done))
  }
  export async function settleOwner(ownerID: string) {
    await Promise.all([...pending.values()].filter((run) => run.ownerID === ownerID).map((run) => run.done))
  }

  export async function reconcile(sessionID: string) {
    if (recovered.has(sessionID)) return
    recovered.add(sessionID)
    try {
      for await (const message of Message.stream(sessionID)) {
        if (!Message.isExternal(message.info) || message.info.role !== "assistant" || message.info.terminal) continue
        await Session.updateInfo({
          ...message.info,
          terminal: "interrupted",
          time: { ...message.info.time, completed: Date.now() },
          error: new Message.AbortedError({
            message: await Text.pick({
              zh: "引擎在外部产品完成本轮回复前重启，任务已中断",
              en: "The engine restarted before this external turn finished",
            }),
          }).toObject(),
        })
      }
    } catch (error) {
      recovered.delete(sessionID)
      throw error
    }
  }

  export async function prompt(input: SessionRunner.PromptInput): Promise<Message.FullMsg> {
    const session = await SessionTarget.assertCanSend(input.sessionID, input)
    if (input.permissionMode)
      await Session.setPermissionMode({ sessionID: session.id, permissionMode: input.permissionMode })
    if (session.target?.kind !== "external")
      throw new Error(await Text.pick({ zh: "此对话没有外部产品目标", en: "The conversation has no external target" }))
    const productID = session.target.productID
    let product = (await configuredProducts()).find((item) => item.id === productID)
    if (!product || product.enabled === false)
      throw new Error(await Text.pick({ zh: "产品已关闭", en: "The product is disabled" }))
    let driven = await adapterOf(product)
    if (!driven) throw new Error(await Text.pick({ zh: "产品尚未安装", en: "The product is not installed" }))
    const runID = randomUUID()
    const execution = {
      kind: "external" as const,
      productID: product.id,
      productTitle: product.title,
      runID,
      targetRevision: session.targetRevision ?? 0,
      requestedModel: undefined as typeof product.model,
    }
    const user: Message.ExternalUserInfo = {
      id: input.messageID ?? Identifier.ascending("message"),
      sessionID: session.id,
      role: "user",
      time: { created: Date.now() },
      permissionMode: input.permissionMode ?? session.permissionMode ?? "ask",
      execution,
      metadata:
        input.metadata || input.messageID ? { ...input.metadata, externalClientMessageID: input.messageID } : undefined,
    }
    {
      using _ = await Lock.write(`external-input:${session.id}`)
      await SessionTarget.assertCanSend(session.id, input)
      const lastID = (await Session.messages({ sessionID: session.id })).at(-1)?.info.id
      const freshID = Identifier.ascending("message")
      if (!input.messageID || (lastID && input.messageID <= lastID) || input.messageID > freshID) user.id = freshID
      await Session.updateInfo(user)
      for (const part of input.parts) {
        if (part.type !== "text")
          throw new Error(
            await Text.pick({ zh: "外部对话仅支持文本", en: "Only text is supported by external conversations" }),
          )
        await Session.updatePart({
          ...part,
          id: part.id ?? Identifier.ascending("part"),
          sessionID: session.id,
          messageID: user.id,
        })
      }
      await Session.touch(session.id)
    }
    let assistant: Message.ExternalAssistantInfo = {
      id: Identifier.ascending("message"),
      sessionID: session.id,
      role: "assistant",
      parentID: user.id,
      time: { created: Date.now() },
      path: { cwd: Instance.directory, root: Instance.worktree },
      execution,
    }
    await Session.updateInfo(assistant)
    const parts = new Map<string, Message.TextPart>()
    const steps: { tool: string; detail?: string }[] = []
    const write = async (messageID: string, partID: string, text: string, append: boolean) => {
      const key = `${messageID}\0${partID}`
      const prev = parts.get(key)
      const part: Message.TextPart = {
        id: prev?.id ?? Identifier.ascending("part"),
        messageID: assistant.id,
        sessionID: session.id,
        type: "text",
        text: append ? (prev?.text ?? "") + text : text,
      }
      parts.set(key, part)
      await Session.updatePart(part)
    }
    const controller = new AbortController()
    const scope = SessionExecution.current(session.id)
    const parent = scope?.controller.signal
    const abort = () => controller.abort(parent?.reason)
    parent?.addEventListener("abort", abort, { once: true })
    if (parent?.aborted) abort()
    const signal = controller.signal
    const finished = Promise.withResolvers<void>()
    pending.set(runID, { ownerID: scope?.id, sessionID: session.id, productID, controller, done: finished.promise })
    const previous = queues.get(session.id) ?? Promise.resolve()
    let release!: () => void
    const completion = new Promise<void>((resolve) => {
      release = resolve
    })
    queues.set(session.id, completion)
    try {
      const cancelled = Promise.withResolvers<never>()
      const reject = () => cancelled.reject(signal.reason)
      signal.addEventListener("abort", reject, { once: true })
      if (signal.aborted) reject()
      try {
        await Promise.race([previous, cancelled.promise])
      } finally {
        signal.removeEventListener("abort", reject)
      }
      await runAdmitted(
        session.id,
        { seatID: session.id, product: productID, paths: [] },
        async () => {
          signal.throwIfAborted()
          // The turn is already saved; its own IDs are not a new history edit.
          await SessionTarget.assertCanSend(session.id)
          product = (await configuredProducts()).find((item) => item.id === productID)!
          driven = await adapterOf(product)
          if (!driven)
            throw new ExternalAdapterError({
              message: await Text.pick({ zh: "产品尚未安装", en: "The product is not installed" }),
            })
          const binding = await Storage.read<Binding>(["external_session", session.id]).catch((error) => {
            if (error instanceof Storage.NotFoundError) return undefined
            throw error
          })
          execution.requestedModel = product.model
          user.execution = { ...execution }
          assistant.execution = { ...execution }
          await Session.updateInfo(user)
          await Session.updateInfo(assistant)
          const currentText = input.parts.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n")
          const history = !binding?.resumeID
            ? (await Session.messages({ sessionID: session.id }))
                .filter((message) => message.info.id < user.id)
                .map(
                  (message) =>
                    `${message.info.role}: ${message.parts.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n")}`,
                )
                .join("\n")
            : ""
          let running!: ReturnType<typeof runExternal>
          const selected = product
          const launch = driven
          await withProduct(selected.id, async (state) => {
            if (!state.enabled)
              throw new ExternalBlockedError({
                message: await Text.pick({
                  zh: "产品在执行前已关闭",
                  en: "The product was disabled before execution",
                }),
              })
            running = runExternal({
              runID,
              sessionID: session.id,
              ...launch,
              task: {
                prompt: history
                  ? `Conversation history (background only; do not repeat previous actions):\n${history}\n\nCurrent user task:\n${currentText}`
                  : currentText,
                cwd: Instance.directory,
                mode: user.permissionMode,
                model: selected.model,
                resume: binding?.productID === selected.id ? binding.resumeID : undefined,
              },
              abort: signal,
              host: {
                sessionStarted: async ({ sessionId }) =>
                  Storage.write<Binding>(["external_session", session.id], {
                    productID: selected.id,
                    resumeID: sessionId,
                    contextMode: "resume",
                  }),
                textDelta: (delta) => write(delta.messageID, delta.partID, delta.delta, true),
                step: async (step) => {
                  steps.push(step)
                  if (steps.length > 50) steps.shift()
                  assistant.metadata = { ...assistant.metadata, externalSteps: [...steps] }
                  await Session.updateInfo(assistant)
                },
                permission: (request) =>
                  decideExternal(
                    { sessionID: session.id, executionID: runID, cwd: Instance.directory, mode: user.permissionMode },
                    request,
                  ),
                question: async (questions) =>
                  Question.ask({
                    sessionID: session.id,
                    root: await Session.rootID(session.id),
                    executionID: runID,
                    questions,
                    abort: signal,
                  }),
              },
            })
          })
          const result = await running
          if (!result.text.trim())
            throw new Error(await Text.pick({ zh: "外部产品未返回正文", en: "The external product returned no text" }))
          if (result.final) {
            const keys = new Set(result.final.parts.map((part) => `${result.final!.messageID}\0${part.partID}`))
            for (const [key, part] of parts) {
              if (!key.startsWith(`${result.final.messageID}\0`) || keys.has(key)) continue
              await Session.removePart({ sessionID: session.id, messageID: assistant.id, partID: part.id })
              parts.delete(key)
            }
            for (const part of result.final.parts) await write(result.final.messageID, part.partID, part.text, false)
          } else if ([...parts.values()].map((part) => part.text).join("") !== result.text) {
            const first = parts.entries().next().value
            if (!first) await write("final", "text", result.text, false)
            else {
              const [key, part] = first
              const complete = { ...part, text: result.text }
              parts.set(key, complete)
              await Session.updatePart(complete)
              for (const [staleKey, stale] of parts) {
                if (staleKey === key) continue
                await Session.removePart({ sessionID: session.id, messageID: assistant.id, partID: stale.id })
                parts.delete(staleKey)
              }
            }
          }
          if (result.sessionId)
            await Storage.write<Binding>(["external_session", session.id], {
              productID,
              resumeID: result.sessionId,
              contextMode: "resume",
            })
          else if (!(await Storage.read<Binding>(["external_session", session.id]).catch(() => undefined)))
            await Storage.write<Binding>(["external_session", session.id], { productID, contextMode: "replay" })
          assistant = {
            ...assistant,
            execution: { ...execution, actualModel: result.actualModel },
            terminal: "completed",
            time: { ...assistant.time, completed: Date.now() },
          }
        },
        signal,
      )
    } catch (error) {
      const cancelled = signal.aborted || !(await productState(productID)).enabled
      assistant = {
        ...assistant,
        terminal: cancelled ? "cancelled" : "failed",
        time: { ...assistant.time, completed: Date.now() },
        error: cancelled
          ? new Message.AbortedError({
              message: await Text.pick({ zh: "外部任务已取消", en: "External execution was cancelled" }),
            }).toObject()
          : new ExternalAdapterError({ message: error instanceof Error ? error.message : String(error) }).toObject(),
      }
    } finally {
      try {
        if (signal.aborted) await settleExternal(session.id)
        await Session.updateInfo(assistant)
      } finally {
        pending.delete(runID)
        parent?.removeEventListener("abort", abort)
        void previous.finally(release)
        void completion.then(() => {
          if (queues.get(session.id) === completion) queues.delete(session.id)
        })
        finished.resolve()
      }
    }
    return { info: assistant, parts: [...parts.values()] }
  }
}
