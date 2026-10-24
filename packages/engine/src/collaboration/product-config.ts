import { parse } from "jsonc-parser"
import { isDeepEqual } from "remeda"
import { z } from "zod"
import { Config } from "../config/config"
import { ConfigEdit } from "../config/config-edit"
import { GroupError } from "./board"
import { BUILTIN_PRODUCTS, configuredProducts, productSources } from "./run"

const ID = /^[A-Za-z0-9_-]+$/

/** What the settings form edits: everything but the switch */
const Form = Config.CollaborationProduct.omit({ enabled: true })
type Form = z.infer<typeof Form>

export const ProductChange = z.discriminatedUnion("type", [
  z.object({ type: z.literal("add"), id: z.string(), product: Form }),
  z.object({ type: z.literal("update"), id: z.string(), product: Form }),
  z.object({ type: z.literal("remove"), id: z.string() }),
  z.object({ type: z.literal("enabled"), id: z.string(), enabled: z.boolean() }),
])
export type ProductChange = z.infer<typeof ProductChange>

const entry = (id: string) => ["collaboration", "products", id]

/** Applies a change made in settings to the products in the global config */
export async function changeProduct(change: ProductChange) {
  if ("product" in change) check(change.id, change.product)
  if (change.type === "add") return add(change.id, change.product)
  await editable(change.id)
  if (change.type === "remove")
    return ConfigEdit.commit("global", (text) => ConfigEdit.set(text, entry(change.id), undefined))
  if (change.type === "update") return update(change.id, change.product)
  return setEnabled(change.id, change.enabled)
}

/**
 * A product saved from the form must be able to run: a custom one needs a command, none may set an empty one, and a
 * session line has to be a regular expression
 */
function check(id: string, product: Form) {
  const command = product.command?.trim()
  const builtin = BUILTIN_PRODUCTS.some((item) => item.id === id)
  if (builtin ? command === "" : !command) throw new GroupError({ zh: "请填写命令", en: "Enter a command" })
  if (product.sessionLine === undefined) return
  try {
    new RegExp(product.sessionLine)
  } catch {
    throw new GroupError({
      zh: "会话 ID 匹配规则不是有效的正则表达式",
      en: "The session line is not a valid regular expression",
    })
  }
}

async function add(id: string, product: Form) {
  if (!ID.test(id))
    throw new GroupError({
      zh: "产品 ID 只能由字母、数字、- 和 _ 组成",
      en: "A product id may only contain letters, digits, - and _",
    })
  const taken = id === "merak" || (await configuredProducts()).some((item) => item.id === id)
  if (taken) throw new GroupError({ zh: `已有产品使用 ID ${id}`, en: `The id ${id} is already taken` })
  await ConfigEdit.commit("global", (text) => ConfigEdit.set(text, entry(id), product))
}

/** Settings change only products it shows as theirs: built in or from the global config */
async function editable(id: string) {
  const [all, sourceOf] = await Promise.all([configuredProducts(), productSources()])
  if (!all.some((item) => item.id === id)) throw new GroupError({ zh: `没有产品 ${id}`, en: `No product ${id}` })
  if (sourceOf(id) === "project")
    throw new GroupError({
      zh: `${id} 由项目配置定义，请在项目的配置文件里修改`,
      en: `${id} is defined in the project config; change it in the project config file`,
    })
}

/**
 * A built-in product keeps only the fields that differ from its default, so later defaults still reach the rest. The
 * switch is not in the form and stays as it is.
 */
async function update(id: string, product: Form) {
  const builtin = BUILTIN_PRODUCTS.find((item) => item.id === id)
  const fields = builtin
    ? Object.fromEntries(
        Object.entries(product).filter(([key, value]) => !isDeepEqual(value, builtin[key as keyof typeof builtin])),
      )
    : product
  await ConfigEdit.commit("global", (text) => {
    const enabled = parse(text)?.collaboration?.products?.[id]?.enabled
    const next = { ...fields, enabled }
    // Nothing differs from the default: no entry, so the product does not read as modified
    const empty = Object.values(next).every((value) => value === undefined)
    return ConfigEdit.set(text, entry(id), empty ? undefined : next)
  })
}

/** Off is written down; on is the default, so it takes the field out, and the entry when nothing else is in it */
function setEnabled(id: string, enabled: boolean) {
  return ConfigEdit.commit("global", (text) => {
    const next = ConfigEdit.set(text, [...entry(id), "enabled"], enabled ? undefined : false)
    const left = parse(next)?.collaboration?.products?.[id]
    return left && Object.keys(left).length === 0 ? ConfigEdit.set(next, entry(id), undefined) : next
  })
}
