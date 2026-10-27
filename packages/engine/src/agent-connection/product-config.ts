import { z } from "zod"
import { parse } from "jsonc-parser"
import { Config } from "../config/config"
import { ConfigEdit } from "../config/config-edit"
import { Text } from "../util/text"
import { BUILTIN_PRODUCTS, configuredProducts } from "./catalog"
import { reconcile } from "./state"
import { conflictingArgument } from "./adapters"

const Form = Config.AgentConnectionProduct.omit({ enabled: true })
export const ProductChange = z.discriminatedUnion("type", [
  z.object({ type: z.literal("add"), id: z.string(), product: Form }),
  z.object({ type: z.literal("update"), id: z.string(), product: Form }),
  z.object({ type: z.literal("remove"), id: z.string() }),
  z.object({ type: z.literal("enabled"), id: z.string(), enabled: z.boolean() }),
])
export type ProductChange = z.infer<typeof ProductChange>

async function invalid(id: string, message: { zh: string; en: string }): Promise<never> {
  throw new Config.InvalidError({ path: `agentConnections.products.${id}`, message: await Text.pick(message) })
}

export async function changeProduct(change: ProductChange) {
  if (!/^[A-Za-z0-9_-]+$/.test(change.id) || change.id === "merak")
    return invalid(change.id, { zh: "产品 ID 无效或为保留 ID", en: "The product ID is invalid or reserved" })
  const all = await configuredProducts()
  if ("product" in change) {
    const builtin = BUILTIN_PRODUCTS.find((product) => product.id === change.id)
    if (builtin ? change.product.command?.trim() === "" : !change.product.command?.trim())
      return invalid(change.id, { zh: "请填写命令", en: "Enter a command" })
    const adapter = change.product.adapter ?? builtin?.adapter ?? "command"
    if (adapter === "opencode" && change.product.model && !change.product.model.providerID)
      return invalid(change.id, { zh: "OpenCode 模型必须指定提供方", en: "An OpenCode model requires a provider" })
    if ((adapter === "claude" || adapter === "codex") && change.product.model?.providerID)
      return invalid(change.id, {
        zh: "此产品的模型不使用提供方字段",
        en: "This product model does not accept a provider field",
      })
    if (adapter === "command") {
      const templates = [change.product.args ?? [], ...(change.product.resumeArgs ? [change.product.resumeArgs] : [])]
      if (templates.some((args) => !!change.product.model !== args.includes("{model}")))
        return invalid(change.id, {
          zh: "模型配置必须与首次及续接参数中的 {model} 占位符一致",
          en: "The model setting must match the {model} placeholder in initial and resume arguments",
        })
    }
    if (change.product.sessionLine !== undefined) {
      try {
        new RegExp(change.product.sessionLine)
      } catch {
        return invalid(change.id, {
          zh: "会话 ID 匹配规则不是有效正则表达式",
          en: "The session ID pattern is not a valid regular expression",
        })
      }
    }
    if (["claude", "codex", "opencode"].includes(adapter)) {
      if (conflictingArgument(adapter, change.product.args ?? []))
        return invalid(change.id, {
          zh: "额外参数不能覆盖模型、适配器协议或权限设置",
          en: "Extra arguments cannot override model, adapter protocol, or permission settings",
        })
    }
  }
  if (change.type === "add") {
    if (all.some((product) => product.id === change.id))
      return invalid(change.id, { zh: "产品 ID 已存在", en: "The product ID is already taken" })
    if (!change.product.command?.trim()) return invalid(change.id, { zh: "请填写命令", en: "Enter a command" })
    await ConfigEdit.commit("global", (text) =>
      ConfigEdit.set(text, ["agentConnections", "products", change.id], change.product),
    )
    await reconcile()
    return
  }
  if (!all.some((product) => product.id === change.id))
    return invalid(change.id, { zh: "没有这个产品", en: "Product not found" })
  if (change.type === "remove" && BUILTIN_PRODUCTS.some((product) => product.id === change.id))
    return invalid(change.id, { zh: "内置产品只能关闭", en: "Built-in products can only be disabled" })
  if (change.type === "remove") {
    await ConfigEdit.commit("global", (text) =>
      ConfigEdit.set(text, ["agentConnections", "products", change.id], undefined),
    )
    await reconcile()
    return
  }
  if (change.type === "update") {
    await ConfigEdit.commit("global", (text) => {
      const enabled = parse(text)?.agentConnections?.products?.[change.id]?.enabled
      return ConfigEdit.set(text, ["agentConnections", "products", change.id], { ...change.product, enabled })
    })
    await reconcile()
    return
  }
  if (change.type === "enabled") {
    await ConfigEdit.commit("global", (text) =>
      ConfigEdit.set(text, ["agentConnections", "products", change.id, "enabled"], change.enabled),
    )
    await reconcile()
    return
  }
}
