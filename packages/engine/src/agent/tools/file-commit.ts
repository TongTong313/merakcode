import { Atomic } from "../../infra/file/atomic"
import { assertCanWritePlanDoc } from "./plan-doc"
import type { Tool } from "./tool"
import { PermissionNext } from "../permission/next"
import { PermissionPolicy } from "../permission/policy"
import { TaskScope } from "../permission/scope"

export async function authorizeToolFile(ctx: Tool.Context, filePath: string, metadata: Record<string, unknown>) {
  const request = {
    permission: "edit",
    checks: [PermissionPolicy.file({ op: "write", path: filePath, ...PermissionPolicy.scope() })],
    metadata: { ...metadata, filepath: filePath },
  }
  const admission = await ctx.ask(request)
  return { request, admission }
}

/** Called inside the tool's file lock after authorization and content validation. */
export async function commitToolFile(
  ctx: Tool.Context,
  filePath: string,
  content: string,
  authorization?: Awaited<ReturnType<typeof authorizeToolFile>>,
) {
  ctx.abort.throwIfAborted()
  await assertCanWritePlanDoc(ctx, filePath)
  await TaskScope.assert(
    ctx.sessionID,
    [PermissionPolicy.file({ op: "write", path: filePath, ...PermissionPolicy.scope() })],
    ctx.messageID,
  )
  let target = filePath
  if (authorization) {
    for (;;) {
      const check = PermissionPolicy.file({ op: "write", path: filePath, ...PermissionPolicy.scope() })
      const changed = JSON.stringify(check) !== JSON.stringify(authorization.request.checks[0])
      const current =
        !authorization.admission ||
        (await PermissionNext.isCurrent(authorization.admission, {
          ...authorization.request,
          sessionID: ctx.sessionID,
          tool: { messageID: ctx.messageID, callID: ctx.callID ?? "" },
        }))
      if (!changed && current) {
        target = check.pattern
        break
      }
      authorization.request.checks = [check]
      authorization.admission = await ctx.ask(authorization.request)
    }
  }
  ctx.abort.throwIfAborted()
  await Atomic.write(target, content)
}
