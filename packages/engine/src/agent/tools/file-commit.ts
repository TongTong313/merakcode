import { Atomic } from "../../infra/file/atomic"
import { SessionPlan } from "../session/plan"
import type { Tool } from "./tool"

/** Called inside the tool's file lock after authorization and content validation. */
export async function commitToolFile(ctx: Tool.Context, filePath: string, content: string) {
  ctx.abort.throwIfAborted()
  if (
    await SessionPlan.writeFromAgent({
      sessionID: ctx.sessionID,
      path: filePath,
      content,
      expectedRevision: ctx.extra?.planRevision,
      abort: ctx.abort,
    })
  )
    return
  ctx.abort.throwIfAborted()
  await Atomic.write(filePath, content)
}
