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
import { configuredProducts, titleOf, type ProductSpec } from "../collaboration/run"
import { setTodo, startTodo } from "../collaboration/todo"
import { open, record, remember } from "../collaboration/store"
import { decide, runMember } from "../collaboration/member"
import { adapterOf } from "../collaboration/adapters"
import { Question } from "../question"

const DESCRIPTION = [
  "Give one member of this group chat a task. Use the member's exact name.",
  "The member cannot see the chat: write the task so it can be done from the task alone, with the results it needs and the paths it may change.",
  "Members whose paths do not overlap can be delegated in the same step and run at the same time.",
  "If a task needs another member's result, delegate that one first and wait for its reply.",
  "A MerakCode member works inside MerakCode; other members run their own installed command.",
].join(" ")

/** How many of an external member's latest steps the chat keeps */
const STEP_LIMIT = 50

type Output = { text: string; sessionID?: string; missing?: boolean }
/** A step a member took, shown in its bubble while it works: the tool and what it touched */
type Step = { tool: string; detail: string }
/** What the chat reads to draw the member bubble */
type Metadata = {
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
    return runAdmitted(ctx.sessionID, { seatID: seat.id, product: seat.product, paths }, async () => {
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
        const product = products.find((item) => item.id === current.product)
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
            : await runAdapter(ctx, product, current, prompt, onStep)
        if (output.missing) {
          await setTodo(ctx.sessionID, todo, "pending")
          return { title: seat.name, output: output.text, metadata: { ...metadata, missing: true } as Metadata }
        }
        await record(ctx.sessionID, { seatID: seat.id, name: current.name, text: output.text, requestID: request.id })
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
        await setTodo(ctx.sessionID, todo, ctx.abort.aborted ? "cancelled" : "pending").catch(() => undefined)
        throw error
      }
    })
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
): Promise<Output> {
  if (!product) throw new Error(`Product is not available: ${seat.product}`)
  const driven = adapterOf(product)
  // Not on this machine: nothing starts, and the task waits for it
  if (!driven) return { text: `${product.title} is not installed, so ${seat.name} did not start.`, missing: true }
  const result = await runMember({
    ...driven,
    task: {
      prompt,
      cwd: Instance.directory,
      mode: ctx.permissionMode ?? ctx.kind ?? "ask",
      resume: seat.privateSessionID,
    },
    abort: ctx.abort,
    host: {
      step: (step) => onStep({ tool: step.tool, detail: shown(step.detail ?? "") }),
      permission: (request) => decide(ctx, request, Instance.directory),
      // The question carries the delegate call, so the chat shows which member asks
      question: (questions) =>
        Question.ask({
          sessionID: ctx.sessionID,
          questions,
          tool: ctx.callID ? { messageID: ctx.messageID, callID: ctx.callID } : undefined,
          abort: ctx.abort,
        }),
    },
  })
  // Whatever a stopped member said before it ended is not a result, nor is an empty reply
  if (ctx.abort.aborted) throw new Error(`${seat.name} was stopped`)
  if (!result.text.trim()) throw new Error(`${driven.product.title} returned no reply`)
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
  if (parent.info.role !== "assistant") throw new Error("Not an assistant message")
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
