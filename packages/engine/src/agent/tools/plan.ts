import z from "zod"
import { Tool } from "./tool"
import { Session } from "../session"
import { Message } from "../session/message"
import { SessionPlan } from "../session/plan"
import { Text } from "../prompt/text"
import { PermissionNext } from "../permission/next"

function result(plan: { path: string; revision: number }) {
  return {
    title: "Plan generated",
    output: `Official plan saved. Revision: ${plan.revision}. Wait for the user to start execution or request changes.`,
    metadata: { planPath: plan.path, revision: plan.revision },
  }
}

function submissionOf(ctx: Tool.Context, params: unknown) {
  return ctx.callID ? { messageID: ctx.messageID, callID: ctx.callID, signature: JSON.stringify(params) } : undefined
}

async function submit(
  params: { content: string; expectedRevision: number },
  ctx: Tool.Context,
  submission: ReturnType<typeof submissionOf>,
) {
  const session = await Session.get(ctx.sessionID)
  if (session.parentID)
    throw new SessionPlan.ConflictError({
      message: await Text.pick({
        zh: "只有根对话可保存官方计划。",
        en: "Only the root conversation can save its official plan.",
      }),
    })
  const previous = submission && (await SessionPlan.submission(ctx.sessionID, submission))
  if (previous) return result(previous)
  const userMessageID = ctx.messages.findLast(
    (message) => message.info.role === "user" && Message.userSourceTexts(message).some((text) => text.trim()),
  )?.info.id
  for (;;) {
    ctx.abort.throwIfAborted()
    const current = await SessionPlan.get(ctx.sessionID)
    const request = {
      permission: "plan_generate",
      checks: [
        {
          permission: "plan_generate",
          pattern: current.path,
          grants: [{ scope: "file" as const, pattern: current.path }],
        },
      ],
      metadata: { planPath: current.path, expectedRevision: params.expectedRevision, update: current.revision > 0 },
    }
    const admission = await ctx.ask(request)
    try {
      const plan = await SessionPlan.save({
        sessionID: ctx.sessionID,
        content: params.content,
        source: "agent",
        abort: ctx.abort,
        userMessageID,
        expectedRevision: params.expectedRevision,
        submission,
        checkAdmission: admission
          ? () =>
              PermissionNext.isCurrent(admission, {
                ...request,
                sessionID: ctx.sessionID,
                tool: { messageID: ctx.messageID, callID: ctx.callID ?? "" },
              })
          : undefined,
      })
      return result(plan)
    } catch (error) {
      if (error instanceof SessionPlan.AdmissionExpiredError) continue
      throw error
    }
  }
}

export const PlanGenerateTool = Tool.define("plan_generate", {
  description:
    "Save Markdown as this conversation's official plan for review, editing and later execution. Use when the user requests a reviewable plan. Draft-only requests do not authorize project changes. Read the latest revision before replacing a plan. Human edits take priority.",
  parameters: z.object({ content: z.string(), expectedRevision: z.number().int().nonnegative() }),
  execute: (params, ctx) => submit(params, ctx, submissionOf(ctx, params)),
})

export const PlanEditTool = Tool.define("plan_edit", {
  description:
    "Edit one unique passage in the official plan. Read the latest revision first. Human edits take priority.",
  parameters: z.object({
    oldString: z.string().min(1),
    newString: z.string(),
    expectedRevision: z.number().int().nonnegative(),
  }),
  async execute(params, ctx) {
    const submission = submissionOf(ctx, params)
    const previous = submission && (await SessionPlan.submission(ctx.sessionID, submission))
    if (previous) return result(previous)
    const current = await SessionPlan.get(ctx.sessionID)
    if (current.content.split(params.oldString).length !== 2)
      throw new SessionPlan.ConflictError({
        message: await Text.pick({
          zh: "计划存在编辑冲突：原文必须唯一匹配，请重新读取计划。",
          en: "Plan conflict: the passage must match exactly once. Reread the current plan.",
        }),
      })
    return submit(
      {
        content: current.content.replace(params.oldString, () => params.newString),
        expectedRevision: params.expectedRevision,
      },
      ctx,
      submission,
    )
  },
})

export const PlanReadChunkTool = Tool.define("plan_read_chunk", {
  description:
    "Read the official plan in complete character ranges. Continue at nextOffset until it is absent, including long lines. An executionID reads that immutable execution snapshot.",
  parameters: SessionPlan.ChunkInput,
  async execute(params, ctx) {
    const plan = await SessionPlan.get(ctx.sessionID)
    await ctx.ask({
      permission: "read",
      checks: [{ permission: "read", pattern: plan.path, grants: [{ scope: "file", pattern: plan.path }] }],
      metadata: { planPath: plan.path },
    })
    const chunk = await SessionPlan.chunk(ctx.sessionID, {
      ...params,
      executionID:
        params.executionID ?? (["executing", "paused"].includes(plan.status) ? plan.execution?.id : undefined),
    })
    return { title: "Plan range", output: JSON.stringify(chunk), metadata: { ...chunk, truncated: false } }
  },
})

export const PlanSimplifyTool = Tool.define("plan_simplify", {
  description:
    "Propose a read-only simplified official plan. Read all ranges first. Preserve commands, identifiers, numbers, prohibitions and acceptance conditions. The user must review every ordered difference and adopt the candidate; this never replaces or executes the official plan.",
  parameters: SessionPlan.Save,
  async execute(params, ctx) {
    const session = await Session.get(ctx.sessionID)
    if (session.parentID)
      throw new SessionPlan.ConflictError({
        message: await Text.pick({
          zh: "只有根对话可提交官方计划精简稿。",
          en: "Only the root conversation can propose an official plan simplification.",
        }),
      })
    const plan = await SessionPlan.get(ctx.sessionID)
    await ctx.ask({
      permission: "plan_simplify",
      checks: [{ permission: "plan_simplify", pattern: plan.path, grants: [] }],
      metadata: { planPath: plan.path },
    })
    const candidate = await SessionPlan.propose(ctx.sessionID, params)
    return {
      title: "Plan candidate",
      output: JSON.stringify(candidate),
      metadata: { candidateID: candidate.id, truncated: false },
    }
  },
})
