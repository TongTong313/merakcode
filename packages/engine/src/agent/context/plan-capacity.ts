import { Token } from "./token"
import { Message } from "../session/message"
import { Text } from "../prompt/text"

/** The same plan reserve is used for native requests and external adapters. */
export namespace PlanCapacity {
  export function reserve(tokens: number) {
    return tokens + Math.max(Math.ceil(tokens * 0.1), 1000)
  }

  export async function assert(input: { content: string; requestTokens: number; availableTokens: number }) {
    const planTokens = Token.estimate(input.content)
    const requiredTokens = input.requestTokens + reserve(planTokens) - planTokens
    if (requiredTokens <= input.availableTokens) return
    const deficit = requiredTokens - input.availableTokens
    const reason = input.requestTokens > input.availableTokens ? "body" : "reserve"
    const explanation = await Text.pick(
      reason === "body"
        ? {
            zh: "当前窗口放不下完整请求。",
            en: "The complete request does not fit the current context window.",
          }
        : {
            zh: "完整请求能放入当前窗口，但安全余量不足。",
            en: "The complete request fits, but its safety reserve does not.",
          },
    )
    throw new Message.PlanCapacityError({
      requiredTokens,
      availableTokens: input.availableTokens,
      deficit,
      reason,
      message: await Text.pick({
        zh: `${explanation}计划请求需要 ${requiredTokens} token，可用 ${input.availableTokens} token，还差 ${deficit} token。请更换大窗口模型或精简计划。`,
        en: `${explanation} The plan request needs ${requiredTokens} tokens, with ${input.availableTokens} available and a deficit of ${deficit}. Select a larger context window or simplify the plan.`,
      }),
    })
  }
}
