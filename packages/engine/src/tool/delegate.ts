import { Tool } from "./tool"
import path from "node:path"
import { z } from "zod"
import { defer } from "@merakcode/util/defer"
import { Identifier } from "@merakcode/util/id"
import { Instance } from "../project/instance"
import { Todo } from "../session/todo"
import { Session } from "../session"
import { Message } from "../session/message"
import { Agent } from "../agent/agent"
import { SessionRunner } from "../session/runner"
import type { Group, Seat } from "../collaboration/board"
import { changedFiles, withOwners } from "../collaboration/artifacts"
import { runAdmitted } from "../collaboration/schedule"
import { memberPrompt } from "../collaboration/prompt"
import { configuredProducts, titleOf, type ProductSpec } from "../agent-connection/catalog"
import { setTodo, startTodo } from "../collaboration/todo"
import { open, record, remember } from "../collaboration/store"
import { decideExternal, runExternal } from "../agent-connection/runtime"
import { adapterOf } from "../agent-connection/adapters"
import { onDisable, productState, withProduct } from "../agent-connection/state"
import { randomUUID } from "node:crypto"
import { Question } from "../question"
import { Text } from "../util/text"
import { ErrorCode } from "@merakcode/util/error-code"
import { errorCode, NamedError, readableErrorText } from "@merakcode/util/error"

const DESCRIPTION = [
  "Give one member of this group chat a task. Use the member's exact name.",
  "The member cannot see the chat: write the task so it can be done from the task alone, with the results it needs and the paths it may change.",
  "Members whose paths do not overlap can be delegated in the same step and run at the same time.",
  "If a task needs another member's result, delegate that one first and wait for its reply.",
  "A MerakCode member works inside MerakCode; other members run their own installed command.",
].join(" ")

/** How many of an external member's latest steps the chat keeps */
const STEP_LIMIT = 50
const queued = new Map<string, { productID: string; controller: AbortController }>()
onDisable((productID) => {
  for (const run of queued.values())
    if (run.productID === productID) run.controller.abort(new DOMException("The product was disabled", "AbortError"))
})

type Output = { text: string; sessionID?: string; missing?: boolean }
/** A step a member took, shown in its bubble while it works: the tool and what it touched */
type Step = { tool: string; detail: string }
/** What the chat reads to draw the member bubble */
type Metadata = {
  external?: Message.ExternalDelegateProgress
  seatID: string
  product: string
  phase?: "queued"
  /** When the member left the queue and began; its working time counts from here */
  started?: number
  sessionId?: string
  missing?: boolean
  /** What an external member has done so far, for the chat only; never part of a prompt */
  steps?: Step[]
}

export const DelegateTool = Tool.define("delegate", {
  description: DESCRIPTION,
  parameters: z.object({
    seat: z.string().describe("The member's name, for example 小红"),
    task: z.string().describe("What the member should do now, complete enough to do without the chat"),
    paths: z.array(z.string()).optional().describe("Files or directories the member may change, such as src/auth/**"),
    todo: z
      .string()
      .optional()
      .describe("Id of the group todo item this task carries out; without it an item is added"),
  }),
  async execute(params, ctx) {
    const group = await open(ctx.sessionID)
    const seat = group.seats.find((item) => item.name === params.seat)
    if (!seat) throw new Error(`No member is named ${params.seat}. Members: ${names(group)}`)
    if (seat.leader) throw new Error("You are the leader; do this work yourself instead of delegating it")
    const paths = params.paths ?? []
    const metadata: Metadata = { seatID: seat.id, product: seat.product }
    ctx.metadata({ title: seat.name, metadata: { ...metadata, phase: "queued" } })
    const request = await userRequest(ctx.sessionID, ctx.messageID)
    const products = await configuredProducts()
    const title = titleOf(products)
    const runID = randomUUID()
    const offlineProgress = (): Message.ExternalDelegateProgress => ({
      runID,
      productTitle: title(seat.product),
      parts: [],
      terminal: "cancelled",
      stopReason: "product-disabled",
    })
    const controller = new AbortController()
    const signal = AbortSignal.any([ctx.abort, controller.signal])
    queued.set(runID, { productID: seat.product, controller })
    try {
      if (seat.product !== "merak" && !(await productState(seat.product)).enabled) {
        const todo = await startTodo(ctx.sessionID, { id: params.todo, seat: seat.name, task: params.task, paths })
        await setTodo(ctx.sessionID, todo, "pending")
        return {
          title: seat.name,
          output: `${seat.name} is offline because ${title(seat.product)} is disabled.`,
          metadata: { ...metadata, external: offlineProgress() },
        }
      }
      return await runAdmitted(
        ctx.sessionID,
        { seatID: seat.id, product: seat.product, paths },
        async () => {
          signal.throwIfAborted()
          metadata.started = Date.now()
          ctx.metadata({ title: seat.name, metadata })
          const steps: Step[] = []
          const todo = await startTodo(ctx.sessionID, { id: params.todo, seat: seat.name, task: params.task, paths })
          try {
            // Built only now, so a member that waited sees the results that came in meanwhile
            const latest = await open(ctx.sessionID)
            const current = latest.seats.find((item) => item.id === seat.id) ?? seat
            const todos = await Todo.get(ctx.sessionID)
            const files = await changedFiles(Instance.directory, latest.baseline).catch(() => [])
            const prompt = memberPrompt({
              group: latest,
              seat: current,
              title,
              request,
              task: params.task,
              paths,
              todos,
              artifacts: withOwners(files, todos),
            })
            const product = (await configuredProducts()).find((item) => item.id === current.product)
            const onStep = (step: Step) => {
              steps.push(step)
              if (steps.length > STEP_LIMIT) steps.shift()
              ctx.metadata({ title: seat.name, metadata: { ...metadata, steps: [...steps] } })
            }
            const output: Output =
              current.product === "merak"
                ? await runMerak(ctx, current, prompt, (sessionId) =>
                    ctx.metadata({ title: seat.name, metadata: { ...metadata, sessionId } }),
                  )
                : await runAdapter(
                    { ...ctx, abort: signal },
                    product,
                    current,
                    prompt,
                    onStep,
                    runID,
                    async (progress) => {
                      metadata.external = progress
                      await ctx.metadata({ title: seat.name, metadata: { ...metadata, steps: [...steps] } })
                    },
                  ).catch(async (error: unknown) => {
                    const fallback = ErrorCode.CATALOG.EXTERNAL_ADAPTER_FAILED
                    const code = errorCode(error instanceof NamedError ? error.toObject() : error) ?? fallback.code
                    const message = readableErrorText(error, await Text.pick(fallback.title))
                    throw new Error(`${code}: ${message}`, { cause: error })
                  })
            if (output.missing) {
              await setTodo(ctx.sessionID, todo, "pending")
              return { title: seat.name, output: output.text, metadata: { ...metadata, missing: true } as Metadata }
            }
            await record(ctx.sessionID, {
              seatID: seat.id,
              name: current.name,
              text: output.text,
              requestID: request.id,
            })
            if (output.sessionID) await remember(ctx.sessionID, seat.id, output.sessionID)
            await setTodo(ctx.sessionID, todo, "completed")
            // A MerakCode member keeps its child session id, so the chat can open its steps
            const sessionId = current.product === "merak" ? output.sessionID : undefined
            return {
              title: seat.name,
              output: output.text,
              metadata: { ...metadata, sessionId, ...(steps.length ? { steps } : {}) } as Metadata,
            }
          } catch (error) {
            if (metadata.external) {
              metadata.external.terminal = signal.aborted ? "cancelled" : "failed"
              if (signal.aborted) metadata.external.stopReason = ctx.abort.aborted ? "user" : "product-disabled"
              await ctx.metadata({ title: seat.name, metadata: { ...metadata } })
            }
            await setTodo(ctx.sessionID, todo, ctx.abort.aborted ? "cancelled" : "pending").catch(() => undefined)
            throw error
          }
        },
        signal,
      )
    } catch (error) {
      if (controller.signal.aborted && !ctx.abort.aborted && !metadata.external) {
        metadata.external = offlineProgress()
        await ctx.metadata({ title: seat.name, metadata: { ...metadata } })
        const message = await Text.pick({
          zh: "产品已关闭，成员已离线",
          en: "The product was disabled; the member is offline",
        })
        throw new Error(`${ErrorCode.CATALOG.EXTERNAL_CONVERSATION_BLOCKED.code}: ${message}`)
      }
      throw error
    } finally {
      queued.delete(runID)
    }
  },
})

function names(group: Group) {
  return group.seats
    .filter((seat) => !seat.leader)
    .map((seat) => seat.name)
    .join(", ")
}

/** The user message this turn answers: its id scopes the results, its words go to every member */
async function userRequest(sessionID: string, messageID: string) {
  const reply = await Message.get({ sessionID, messageID }).catch(() => undefined)
  const userID = reply?.info.role === "assistant" ? reply.info.parentID : undefined
  if (!userID) return { id: messageID, text: "" }
  const user = await Message.get({ sessionID, messageID: userID }).catch(() => undefined)
  const text = (user?.parts ?? [])
    .flatMap((part) => (part.type === "text" && !part.synthetic ? [part.text] : []))
    .join("\n")
    .trim()
  return { id: userID, text }
}

/** A member driven by an adapter: its permission requests come to MerakCode, under the group's permission mode */
async function runAdapter(
  ctx: Tool.Context,
  product: ProductSpec | undefined,
  seat: Seat,
  prompt: string,
  onStep: (step: Step) => void,
  runID: string,
  onProgress: (progress: Message.ExternalDelegateProgress) => Promise<void>,
): Promise<Output> {
  if (!product) throw new Error(`Product is not available: ${seat.product}`)
  const driven = await adapterOf(product)
  // Not on this machine: nothing starts, and the task waits for it
  if (!driven) return { text: `${product.title} is not installed, so ${seat.name} did not start.`, missing: true }
  const progress: Message.ExternalDelegateProgress = {
    runID,
    productTitle: product.title,
    requestedModel: product.model,
    parts: [],
  }
  const indexes = new Map<string, string>()
  const text = async (messageID: string, partID: string, value: string, append: boolean) => {
    const key = `${messageID}\0${partID}`
    const id = indexes.get(key) ?? Identifier.ascending("part")
    indexes.set(key, id)
    const part = progress.parts.find((item) => item.id === id)
    if (part) part.text = append ? part.text + value : value
    else progress.parts.push({ id, text: value })
    await onProgress(structuredClone(progress))
  }
  let running!: ReturnType<typeof runExternal>
  await withProduct(product.id, (state) => {
    ctx.abort.throwIfAborted()
    if (!state.enabled) throw new Error(`${product.title} is offline`)
    running = runExternal({
      runID,
      sessionID: ctx.sessionID,
      seatID: seat.id,
      ...driven,
      task: {
        prompt,
        cwd: Instance.directory,
        mode: ctx.permissionMode ?? ctx.kind ?? "ask",
        resume: seat.privateSessionID,
        model: product.model,
      },
      abort: ctx.abort,
      host: {
        step: (step) => onStep({ tool: step.tool, detail: shown(step.detail ?? "") }),
        sessionStarted: async ({ sessionId }) => {
          await remember(ctx.sessionID, seat.id, sessionId)
        },
        textDelta: (delta) => text(delta.messageID, delta.partID, delta.delta, true),
        permission: (request) =>
          decideExternal(
            {
              sessionID: ctx.sessionID,
              executionID: runID,
              cwd: Instance.directory,
              mode: ctx.permissionMode ?? ctx.kind,
              tool: ctx.callID ? { messageID: ctx.messageID, callID: ctx.callID } : undefined,
            },
            request,
          ),
        // The question carries the delegate call, so the chat shows which member asks
        question: async (questions) =>
          Question.ask({
            sessionID: ctx.sessionID,
            executionID: runID,
            root: await Session.rootID(ctx.sessionID),
            questions,
            tool: ctx.callID ? { messageID: ctx.messageID, callID: ctx.callID } : undefined,
            abort: ctx.abort,
          }),
      },
    })
  })
  const result = await running
  // Whatever a stopped member said before it ended is not a result, nor is an empty reply.
  if (ctx.abort.aborted) throw new Error(`${seat.name} was stopped`)
  if (!result.text.trim())
    throw new Error(
      await Text.pick(
        { zh: "{product} 未返回正文", en: "{product} returned no reply" },
        { product: driven.product.title },
      ),
    )
  if (result.final) {
    const keys = new Set(result.final.parts.map((part) => `${result.final!.messageID}\0${part.partID}`))
    for (const [key, id] of indexes) {
      if (!key.startsWith(`${result.final.messageID}\0`) || keys.has(key)) continue
      progress.parts = progress.parts.filter((part) => part.id !== id)
      indexes.delete(key)
    }
    for (const part of result.final.parts) await text(result.final.messageID, part.partID, part.text, false)
  } else if (progress.parts.map((part) => part.text).join("") !== result.text) {
    const first = progress.parts[0]
    if (first) progress.parts = [{ ...first, text: result.text }]
    else await text("final", "text", result.text, false)
  }
  progress.actualModel = result.actualModel
  progress.terminal = "completed"
  await onProgress(structuredClone(progress))
  return { text: result.text, sessionID: result.sessionId }
}

/** A step's detail as the chat shows it: a path in the project relative to it, anything else as it is */
function shown(detail: string) {
  if (!path.isAbsolute(detail)) return detail
  const relative = path.relative(Instance.directory, detail)
  return relative && !relative.startsWith("..") && !path.isAbsolute(relative) ? relative.replaceAll("\\", "/") : detail
}

/** A MerakCode member works in a child session of its own; stopping the group stops it too */
async function runMerak(
  ctx: { sessionID: string; messageID: string; abort: AbortSignal },
  seat: Seat,
  prompt: string,
  started: (sessionID: string) => void,
) {
  const child = seat.privateSessionID ? await Session.get(seat.privateSessionID).catch(() => undefined) : undefined
  const session = child ?? (await Session.create({ parentID: ctx.sessionID, title: seat.name }))
  const parent = await Message.get({ sessionID: ctx.sessionID, messageID: ctx.messageID })
  if (parent.info.role !== "assistant" || Message.isExternal(parent.info))
    throw new Error("Not a native assistant message")
  const agent = (await Agent.get("build")) ?? (await Agent.get(parent.info.agent))
  if (!agent) throw new Error("No agent is available for a Merak seat")
  started(session.id)
  const cancel = () => SessionRunner.cancel(session.id)
  ctx.abort.addEventListener("abort", cancel)
  using _ = defer(() => ctx.abort.removeEventListener("abort", cancel))
  const parts = await SessionRunner.resolvePromptParts(prompt)
  const result = await SessionRunner.prompt({
    sessionID: session.id,
    messageID: Identifier.ascending("message"),
    model: { modelID: parent.info.modelID, providerID: parent.info.providerID },
    agent: agent.id,
    parts,
  })
  // A stopped child returns its partial reply instead of throwing; neither that nor an empty reply is a result
  if (ctx.abort.aborted) throw new Error(`${seat.name} was stopped`)
  const textPart = result.parts.findLast((part) => part.type === "text")
  const text = textPart?.type === "text" ? textPart.text.trim() : ""
  if (!text) throw new Error(`${seat.name} returned no reply`)
  return { text, sessionID: session.id }
}
