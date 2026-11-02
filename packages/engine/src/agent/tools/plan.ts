import z from "zod"
import { Tool } from "./tool"
import { Question } from "../session/question"
import { Session } from "../session"
import { Message } from "../session/message"
import { Identifier } from "@merakcode/util/id"
import { Provider } from "../model/provider"
import EXIT_DESCRIPTION from "./plan-exit.txt"
import ENTER_DESCRIPTION from "./plan-enter.txt"
import { Filesystem } from "@merakcode/util/filesystem"
import { SessionMode } from "../permission/mode"
import { SessionPlan } from "../session/plan"
import { Text } from "../prompt/text"

/**
 * Timeout of the plan_enter suggestion; on timeout the current mode is kept.
 * Completed plans wait for human review without a timeout.
 */
const PLAN_SWITCH_CONFIRM_TIMEOUT_MS = 15_000

/** Confirmation dialog text, shown to the user in the configured locale */
const TEXT = {
  yes: { zh: "同意", en: "Yes" },
  skip: { zh: "跳过", en: "Skip" },
  // Used when a plan file already exists; the first entry uses `enter`, which is about researching and writing
  revise: {
    question: {
      zh: "要切回计划模式修改方案 {plan} 吗？（计划模式下只读不改；15 秒无响应将保持当前模式）",
      en: "Return to plan mode to revise the plan at {plan}? (read-only while planning; stays in the current mode if no response within 15s)",
    },
    header: { zh: "切回计划模式", en: "Return to Plan Mode" },
    yesDescription: { zh: "切到计划模式，允许修改方案", en: "Switch to plan mode and allow revising the plan" },
    skipDescription: {
      zh: "保持当前模式，不修改方案文件",
      en: "Stay in the current mode; the plan file is not edited",
    },
  },
  enter: {
    question: {
      zh: "要切到计划模式，先调研再把方案写到 {plan} 吗？（计划模式下只读不改；15 秒无响应将保持当前模式）",
      en: "Switch to plan mode to research first and save a plan to {plan}? (read-only while planning; stays in the current mode if no response within 15s)",
    },
    header: { zh: "计划模式", en: "Plan Mode" },
    yesDescription: { zh: "切到计划模式，调研并写方案", en: "Switch to plan mode for research and planning" },
    skipDescription: { zh: "什么都不做，保持当前模式", en: "Do nothing; stay in the current mode" },
  },
} satisfies Record<string, Text.Pair | Record<string, Text.Pair>>

function dialog(
  texts: Record<"question" | "header" | "yesDescription" | "skipDescription", Text.Pair>,
  lang: Text.Lang,
  params: Record<string, unknown>,
) {
  return {
    question: Text.format(texts.question, lang, params),
    header: Text.format(texts.header, lang, params),
    yesDescription: Text.format(texts.yesDescription, lang, params),
    skipDescription: Text.format(texts.skipDescription, lang, params),
  }
}

async function getLastModel(sessionID: string) {
  for await (const item of Message.stream(sessionID)) {
    if (!Message.isExternal(item.info) && item.info.role === "user" && item.info.model) return item.info.model
  }
  return Provider.defaultModel()
}

/** Explicit yes, explicit skip, or no answer in time; kept apart so each direction can choose its timeout default */
type ConfirmResult = "accept" | "skip" | "timeout"

/**
 * Shows the plan mode switch dialog and returns the user's choice; unexpected errors must not count as a skip.
 * - "Yes" → "accept"
 * - the explicit "Skip" option → "skip"
 * - no answer within timeoutMs → "timeout" (plan_enter passes 15 s)
 * - session aborted → "skip" (the turn is aborted, so the result is discarded)
 */
async function confirmSwitch(input: {
  ctx: Tool.Context
  lang: Text.Lang
  question: string
  header: string
  yesDescription: string
  skipDescription: string
  timeoutMs?: number
}): Promise<ConfirmResult> {
  const labels = { yes: Text.format(TEXT.yes, input.lang), skip: Text.format(TEXT.skip, input.lang) }
  try {
    const answers = await Question.ask({
      sessionID: input.ctx.sessionID,
      root: await Session.rootID(input.ctx.sessionID),
      questions: [
        {
          question: input.question,
          header: input.header,
          custom: false,
          dismiss: false,
          options: [
            { label: labels.yes, description: input.yesDescription },
            { label: labels.skip, description: input.skipDescription },
          ],
        },
      ],
      tool: input.ctx.callID ? { messageID: input.ctx.messageID, callID: input.ctx.callID } : undefined,
      abort: input.ctx.abort,
      ...(input.timeoutMs !== undefined ? { timeoutMs: input.timeoutMs } : {}),
    })
    const answer = answers[0]?.[0]
    if (answer === labels.yes) return "accept"
    if (answer === labels.skip) return "skip"
    return "timeout"
  } catch (err) {
    if (err instanceof Question.AbortedError) return "skip"
    throw err
  }
}

/**
 * Switches the session's permission mode and writes a synthetic user message in that mode so the turn continues
 * under the new mode (the runner does not end the turn while there is a new user message). The agent stays the same.
 */
async function switchMode(ctx: Tool.Context, mode: SessionMode.Value, text: string, expectedRevision: number) {
  const selected = await Session.setMode({ sessionID: ctx.sessionID, sessionMode: mode, expectedRevision })
  if (selected.sessionMode !== mode) return false
  const userInfo: Message.UserInfo = {
    id: Identifier.ascending("message"),
    sessionID: ctx.sessionID,
    role: "user",
    time: {
      created: Date.now(),
    },
    agent: ctx.agent,
    model: await getLastModel(ctx.sessionID),
    sessionMode: mode,
  }
  await Session.updateInfo(userInfo)
  await Session.updatePart({
    id: Identifier.ascending("part"),
    messageID: userInfo.id,
    sessionID: ctx.sessionID,
    type: "text",
    text,
    synthetic: true,
  } satisfies Message.TextPart)
  return true
}

export const PlanWriteTool = Tool.define("plan_write", {
  description:
    "Write the current session plan. Human edits take priority. Read the latest plan after a conflict; never retry stale generated content.",
  parameters: z.object({ content: z.string(), expectedRevision: z.number().int().nonnegative().optional() }),
  async execute(params, ctx) {
    const session = await Session.get(ctx.sessionID)
    if (session.parentID || !["plan", "auto"].includes(ctx.sessionMode ?? "execute"))
      throw new SessionPlan.ConflictError({
        message: await Text.pick({
          zh: "请先进入计划模式再编辑计划。",
          en: "Enter plan mode before editing the session plan.",
        }),
      })
    const current = await SessionPlan.get(ctx.sessionID)
    const userMessageID = ctx.messages.findLast(
      (message) => message.info.role === "user" && Message.userSourceTexts(message).some((text) => text.trim()),
    )?.info.id
    const plan = await SessionPlan.save({
      sessionID: ctx.sessionID,
      content: params.content,
      source: "agent",
      abort: ctx.abort,
      userMessageID,
      expectedRevision: ctx.extra?.planRevision ?? params.expectedRevision ?? current.revision,
    })
    return {
      title: "Plan saved",
      output: `Plan saved at ${plan.path}. Revision: ${plan.revision}. Call plan_exit when ready for review.`,
      metadata: { planPath: plan.path },
    }
  },
})

export const PlanEditTool = Tool.define("plan_edit", {
  description: "Edit the current session plan by replacing one exact passage. Human edits take priority.",
  parameters: z.object({
    oldString: z.string().min(1),
    newString: z.string(),
    expectedRevision: z.number().int().nonnegative().optional(),
  }),
  async execute(params, ctx) {
    const current = await SessionPlan.get(ctx.sessionID)
    if (current.content.split(params.oldString).length !== 2)
      throw new SessionPlan.ConflictError({
        message: await Text.pick({
          zh: "计划存在编辑冲突：原文必须唯一匹配，请重新读取计划。",
          en: "Plan conflict: the passage must match exactly once. Reread the current plan.",
        }),
      })
    const tool = await PlanWriteTool.init()
    return tool.execute(
      {
        content: current.content.replace(params.oldString, () => params.newString),
        expectedRevision: params.expectedRevision,
      },
      ctx,
    )
  },
})

export const PlanExitTool = Tool.define("plan_exit", {
  description: EXIT_DESCRIPTION,
  parameters: z.object({}),
  async execute(_params, ctx) {
    const current = await SessionPlan.get(ctx.sessionID)
    if (!current.content.trim())
      throw new SessionPlan.ConflictError({
        message: await Text.pick({
          zh: "请先编写计划，再提交审核。",
          en: "Write the plan before submitting it for review.",
        }),
      })
    await SessionPlan.setStatus(ctx.sessionID, "review", ctx.abort)
    return {
      title: "Plan ready for review",
      output:
        "The plan is ready. Wait for the user to start execution, edit the plan, or send revision instructions. Do not start implementing.",
      metadata: { planPath: current.path, switched: false, mode: undefined as SessionMode.Value | undefined },
      stop: true,
    }
  },
})

export const PlanEnterTool = Tool.define("plan_enter", {
  description: ENTER_DESCRIPTION,
  parameters: z.object({}),
  async execute(_params, ctx) {
    const session = await Session.get(ctx.sessionID)
    const plan = Session.plan(session)
    if ((ctx.sessionMode ?? ctx.kind) === "plan")
      return {
        title: "Already in plan mode",
        output: `Plan mode is already active. Keep planning in ${plan}.`,
        metadata: {
          planPath: plan,
          planRelPath: plan,
          switched: false,
          mode: undefined as SessionMode.Value | undefined,
        },
      }
    const lang = await Text.lang()
    const texts = dialog((await Filesystem.isFile(plan)) ? TEXT.revise : TEXT.enter, lang, { plan })

    // Lets the confirmation dialog preview or open the plan file
    await ctx.metadata({ title: texts.header, metadata: { planPath: plan, planRelPath: plan } })

    const accepted =
      (await confirmSwitch({ ctx, lang, ...texts, timeoutMs: PLAN_SWITCH_CONFIRM_TIMEOUT_MS })) === "accept"
    if (!accepted) {
      return {
        title: "Plan mode skipped",
        output:
          "User skipped entering plan mode (chose Skip / timed out / session aborted). " +
          "This tool did NOT terminate the turn. " +
          "Continue in the current mode; do not call plan_enter again unless the user explicitly asks.",
        // switched=false tells clients nothing changed, so a completed status is not mistaken for approval
        metadata: {
          planPath: plan,
          planRelPath: plan,
          switched: false,
          mode: undefined as SessionMode.Value | undefined,
        },
      }
    }

    const latest = await Session.get(ctx.sessionID)
    if ((latest.modeRevision ?? 0) !== (session.modeRevision ?? 0))
      return {
        title: "Mode already changed",
        output: "Keep the current mode selected by the user.",
        metadata: {
          planPath: plan,
          planRelPath: plan,
          switched: false,
          mode: undefined as SessionMode.Value | undefined,
        },
      }
    const switched = await switchMode(
      ctx,
      "plan",
      "User has requested to enter plan mode. Switch to plan mode and begin planning.",
      session.modeRevision ?? 0,
    )
    if (!switched)
      return {
        title: "Mode already changed",
        output: "Keep the current mode selected by the user.",
        metadata: {
          planPath: plan,
          planRelPath: plan,
          switched: false,
          mode: undefined as SessionMode.Value | undefined,
        },
      }
    return {
      title: "Switching to plan mode",
      output: `User confirmed to switch to plan mode. The plan file will be at ${plan}. Begin planning.`,
      metadata: {
        planPath: plan,
        planRelPath: plan,
        switched: true,
        mode: "plan" as SessionMode.Value | undefined,
      },
    }
  },
})
