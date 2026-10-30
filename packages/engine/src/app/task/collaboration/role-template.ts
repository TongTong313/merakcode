import { z } from "zod"
import { Config } from "../../config/files/config"
import { Text } from "../../../agent/prompt/text"
import { HTTPException } from "hono/http-exception"
import { ConfigEdit } from "../../../infra/config/edit"

export const RoleTemplate = z
  .object({
    id: z.string(),
    name: z.string(),
    role: z.string(),
    duty: z.string(),
    description: z.string().optional(),
    builtin: z.boolean(),
    editable: z.boolean(),
  })
  .meta({ ref: "CollaborationRoleTemplate" })

export const RoleTemplateChange = z.discriminatedUnion("type", [
  z.object({ type: z.literal("add"), id: z.string(), template: Config.RoleTemplate }),
  z.object({ type: z.literal("update"), id: z.string(), template: Config.RoleTemplate }),
  z.object({ type: z.literal("remove"), id: z.string() }),
])

export async function changeRoleTemplate(change: z.infer<typeof RoleTemplateChange>) {
  if (change.id.startsWith("builtin-"))
    throw new HTTPException(403, {
      message: await Text.pick({
        zh: "内置角色模板不可修改或删除，请先复制",
        en: "Built-in role templates are read-only; copy one to customize it",
      }),
    })
  if (!/^[A-Za-z0-9_-]+$/.test(change.id))
    throw new Config.InvalidError({
      path: `collaboration.roleTemplates.${change.id}`,
      message: await Text.pick({ zh: "角色模板 ID 无效", en: "Invalid role template ID" }),
    })
  if (change.type === "add") {
    if ((await Config.getGlobal()).collaboration?.roleTemplates?.[change.id])
      throw new Config.InvalidError({
        path: `collaboration.roleTemplates.${change.id}`,
        message: await Text.pick({ zh: "角色模板 ID 已存在", en: "The role template ID is already taken" }),
      })
    await Config.edit("global", (text) =>
      ConfigEdit.set(text, ["collaboration", "roleTemplates", change.id], change.template),
    )
    return
  }
  if (!(await Config.getGlobal()).collaboration?.roleTemplates?.[change.id])
    throw new Config.InvalidError({
      path: `collaboration.roleTemplates.${change.id}`,
      message: await Text.pick({ zh: "没有这个角色模板", en: "Role template not found" }),
    })
  if (change.type === "update") {
    await Config.edit("global", (text) =>
      ConfigEdit.set(text, ["collaboration", "roleTemplates", change.id], change.template),
    )
    return
  }
  await Config.edit("global", (text) => ConfigEdit.set(text, ["collaboration", "roleTemplates", change.id], undefined))
}

const builtins = [
  {
    id: "builtin-product-manager",
    name: { zh: "产品经理", en: "PM" },
    role: { zh: "产品经理", en: "Product manager" },
    duty: "Clarify the user goal, scope, constraints, and acceptance criteria. Identify unresolved requirements and report decisions and questions explicitly.",
  },
  {
    id: "builtin-architect",
    name: { zh: "架构师", en: "Architect" },
    role: { zh: "架构师", en: "Architect" },
    duty: "Define module responsibilities, interfaces, data flow, and failure behavior. Compare concrete tradeoffs against the current codebase and record decisions needed by implementers.",
  },
  {
    id: "builtin-developer",
    name: { zh: "开发工程师", en: "Developer" },
    role: { zh: "开发工程师", en: "Developer" },
    duty: "Implement the assigned behavior within the agreed scope. Follow repository conventions, write behavior tests, verify the result, and report limitations.",
  },
  {
    id: "builtin-tester",
    name: { zh: "测试工程师", en: "Tester" },
    role: { zh: "测试工程师", en: "Test engineer" },
    duty: "Derive test scenarios from acceptance criteria. Exercise success, failure, boundaries, cancellation, and regressions through public interfaces. Produce reproducible evidence.",
  },
  {
    id: "builtin-reviewer",
    name: { zh: "代码评审员", en: "Reviewer" },
    role: { zh: "代码评审员", en: "Code reviewer" },
    duty: "Review correctness, maintainability, and regression risk. Prioritize actionable findings with code locations, triggering conditions, and consequences. Avoid unrelated rewrites.",
  },
  {
    id: "builtin-devops",
    name: { zh: "运维工程师", en: "DevOps" },
    role: { zh: "运维工程师", en: "DevOps engineer" },
    duty: "Assess build, runtime configuration, deployment, observability, and recovery. Prefer reproducible commands and reversible changes. Execute deployment only within authorized scope.",
  },
  {
    id: "builtin-security",
    name: { zh: "安全工程师", en: "Security" },
    role: { zh: "安全工程师", en: "Security engineer" },
    duty: "Review authentication, authorization, untrusted input, secret handling, and dependency boundaries. Explain concrete attack conditions and remediation for confirmed findings.",
  },
]

export async function roleTemplates(): Promise<z.infer<typeof RoleTemplate>[]> {
  const list = await Promise.all(
    builtins.map(async (template) => ({
      id: template.id,
      name: await Text.pick(template.name),
      role: await Text.pick(template.role),
      description: await Text.pick(template.role),
      duty: template.duty,
      builtin: true,
      editable: false,
    })),
  )
  const custom = (await Config.getGlobal()).collaboration?.roleTemplates ?? {}
  return [
    ...list,
    ...Object.entries(custom)
      .filter(([id]) => !id.startsWith("builtin-"))
      .map(([id, template]) => ({ id, ...template, builtin: false, editable: true })),
  ]
}
