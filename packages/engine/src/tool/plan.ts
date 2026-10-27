import z from "zod"
import { Tool } from "./tool"
import { Question } from "../question"
import { Session } from "../session"
import { Message } from "../session/message"
import { Identifier } from "@merakcode/util/id"
import { Provider } from "../provider/provider"
import EXIT_DESCRIPTION from "./plan-exit.txt"
import ENTER_DESCRIPTION from "./plan-enter.txt"
import { Filesystem } from "@merakcode/util/filesystem"
import { PermissionMode } from "../permission/mode"
import { Text } from "../util/text"

/**
 * Timeout of the plan_enter / plan_exit confirmation; on timeout the current mode is kept.
 * Plan mode is the read-only mode: plan_enter switches to read-only, plan_exit returns to the mode used before it.
 */
const PLAN_SWITCH_CONFIRM_TIMEOUT_MS = 15_000

/** Confirmation dialog text, shown to the user in the configured locale */
const TEXT = {
  yes: { zh: "同意", en: "Yes" },
  skip: { zh: "跳过", en: "Skip" },
  exit: {
    question: {
      zh: "{plan} 的方案已完成，要切换到「{name}」模式开始实施吗？（15 秒无响应将留在计划模式）",
      en: "Plan at {plan} is complete. Switch to {name} mode and start implementing? (stays in plan mode if no response within 15s)",
    },
    header: { zh: "切换到{name}模式", en: "Switch to {name} mode" },
    yesDescription: {
      zh: "切换到「{name}」模式，按方案开始实施",
      en: "Switch to {name} mode and start implementing the plan",
    },
    skipDescription: {
      zh: "什么都不做，留在计划模式继续完善",
      en: "Do nothing; remain in plan mode and keep refining",
    },
  },
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

/** Mode names shown in the dialog */
const MODE_NAMES: Record<PermissionMode.Value, Text.Pair> = {
  readonly: { zh: "只读", en: "read-only" },
  ask: { zh: "询问", en: "ask" },
  auto: { zh: "自动", en: "auto" },
}

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

/**
 * Message.stream yields the newest messages first, so the first user message not in read-only mode gives the mode
 * used right before plan mode was entered. Falls back to ask mode when there is none.
 */
export async function findReturnMode(sessionID: string): Promise<PermissionMode.Value> {
  for await (const item of Message.stream(sessionID)) {
    if (item.info.role !== "user" || !item.info.permissionMode) continue
    if (item.info.permissionMode !== "readonly") return item.info.permissionMode
  }
  return PermissionMode.DEFAULT
}

/** Explicit yes, explicit skip, or no answer in time; kept apart so each direction can choose its timeout default */
type ConfirmResult = "accept" | "skip" | "timeout"

/**
 * Shows the plan mode switch dialog and returns the user's choice; unexpected errors must not count as a skip.
 * - "Yes" → "accept"
 * - the explicit "Skip" option → "skip"
 * - no answer within timeoutMs → "timeout" (enter and exit both pass 15 s)
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
async function switchMode(ctx: Tool.Context, mode: PermissionMode.Value, text: string) {
  await Session.setPermissionMode({ sessionID: ctx.sessionID, permissionMode: mode })
  const userInfo: Message.UserInfo = {
    id: Identifier.ascending("message"),
    sessionID: ctx.sessionID,
    role: "user",
    time: {
      created: Date.now(),
    },
    agent: ctx.agent,
    model: await getLastModel(ctx.sessionID),
    permissionMode: mode,
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
}

export const PlanExitTool = Tool.define("plan_exit", {
  description: EXIT_DESCRIPTION,
  parameters: z.object({}),
  async execute(_params, ctx) {
    const session = await Session.get(ctx.sessionID)
    const plan = Session.plan(session)
    if ((ctx.permissionMode ?? ctx.kind) !== "readonly")
      return {
        title: "Not in plan mode",
        output: "Plan mode is not active, so there is nothing to exit. Continue with the task.",
        metadata: {
          planPath: plan,
          planRelPath: plan,
          switched: false,
          mode: undefined as PermissionMode.Value | undefined,
        },
      }
    const mode = await findReturnMode(ctx.sessionID)
    const lang = await Text.lang()
    const texts = dialog(TEXT.exit, lang, { plan, name: Text.format(MODE_NAMES[mode], lang) })

    // Lets the confirmation dialog preview or open the plan file
    await ctx.metadata({ title: texts.header, metadata: { planPath: plan, planRelPath: plan } })

    // Approving the plan is the point of plan mode: always ask, and stay in plan mode without an answer in 15 s
    const result = await confirmSwitch({ ctx, lang, ...texts, timeoutMs: PLAN_SWITCH_CONFIRM_TIMEOUT_MS })
    if (result !== "accept") {
      return {
        title: "Staying in plan mode",
        output:
          "User skipped leaving plan mode (chose Skip / timed out / session aborted). " +
          "This tool did NOT terminate the turn. " +
          "Stay in plan mode and continue refining; do not call plan_exit again unless the user explicitly asks.",
        // switched=false tells clients nothing changed, so a completed status is not mistaken for approval
        metadata: {
          planPath: plan,
          planRelPath: plan,
          switched: false,
          mode: undefined as PermissionMode.Value | undefined,
        },
      }
    }

    await switchMode(ctx, mode, `The plan at ${plan} has been approved, you can now edit files. Execute the plan`)
    return {
      title: `Switching to ${mode} mode`,
      output: `User approved leaving plan mode. Switched to ${mode} mode. Wait for further instructions.`,
      metadata: { planPath: plan, planRelPath: plan, switched: true, mode: mode as PermissionMode.Value | undefined },
    }
  },
})

export const PlanEnterTool = Tool.define("plan_enter", {
  description: ENTER_DESCRIPTION,
  parameters: z.object({}),
  async execute(_params, ctx) {
    const session = await Session.get(ctx.sessionID)
    const plan = Session.plan(session)
    if ((ctx.permissionMode ?? ctx.kind) === "readonly")
      return {
        title: "Already in plan mode",
        output: `Plan mode is already active. Keep planning in ${plan}.`,
        metadata: {
          planPath: plan,
          planRelPath: plan,
          switched: false,
          mode: undefined as PermissionMode.Value | undefined,
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
          mode: undefined as PermissionMode.Value | undefined,
        },
      }
    }

    await switchMode(ctx, "readonly", "User has requested to enter plan mode. Switch to plan mode and begin planning.")
    return {
      title: "Switching to plan mode",
      output: `User confirmed to switch to plan mode. The plan file will be at ${plan}. Begin planning.`,
      metadata: {
        planPath: plan,
        planRelPath: plan,
        switched: true,
        mode: "readonly" as PermissionMode.Value | undefined,
      },
    }
  },
})
