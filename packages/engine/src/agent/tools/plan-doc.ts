import path from "path"
import { Global } from "../../infra/global"
import { Filesystem } from "@merakcode/util/filesystem"
import { SessionPlan } from "../session/plan"
import { Text } from "../prompt/text"
import type { PermissionLevel } from "../permission/level"

export type PlanDocAuthor = { agent: string; permissionLevel?: PermissionLevel.Value; sessionID?: string }

export function isUnderPlansDataDir(absPath: string, plansDir = path.join(Global.Path.data, "plans")): boolean {
  return path.extname(absPath).toLowerCase() === ".md" && Filesystem.contains(plansDir, path.normalize(absPath))
}

/** Only the dedicated plan tools can save official plans, including file identity aliases. */
export async function assertCanWritePlanDoc(author: PlanDocAuthor, absPath: string): Promise<void> {
  if (!isUnderPlansDataDir(absPath) && !(author.sessionID && (await SessionPlan.isFile(author.sessionID, absPath))))
    return
  throw new SessionPlan.ConflictError({
    message: await Text.pick({
      zh: "请使用官方计划工具保存计划。通用文件工具不能修改官方计划。",
      en: "Use the official plan tools to save the plan. General file tools cannot modify official plans.",
    }),
  })
}
