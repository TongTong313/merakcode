import { connectionDefaults } from "./product.fixture"
import { beforeEach, expect, test } from "vitest"
import { setLocale } from "../../i18n"
import { copyGroup } from "./group-copy"
import type { Product } from "./members"

beforeEach(() => setLocale("zh"))

const product = (id: string, title: string, fields: Partial<Product> = {}): Product => ({
  id,
  title,
  connected: true,
  enabled: true,
  builtin: true,
  source: "builtin",
  ...connectionDefaults,
  ...fields,
})

test("a copy keeps the name and each member's name, role, duty and product, and leaves out members it cannot seat", () => {
  const products = [
    product("merak", "MerakCode"),
    product("claude", "Claude Code"),
    product("codex", "Codex", { connected: false }),
    product("opencode", "OpenCode", { enabled: false }),
  ]
  const copy = copyGroup(
    {
      sessionID: "s",
      title: "登录小组",
      directory: "/old",
      seats: [
        { name: "小主", role: "组长", duty: "带队", product: "merak", leader: true, availability: { state: "online" } },
        {
          name: "小红",
          role: "产品经理",
          duty: "写需求",
          product: "claude",
          leader: false,
          availability: { state: "online" },
        },
        {
          name: "小刚",
          role: "",
          duty: "",
          product: "codex",
          leader: false,
          availability: { state: "offline", reason: "not installed" },
        },
        {
          name: "小李",
          role: "",
          duty: "",
          product: "opencode",
          leader: false,
          availability: { state: "offline", reason: "disabled" },
        },
        {
          name: "小王",
          role: "",
          duty: "",
          product: "gone",
          leader: false,
          availability: { state: "offline", reason: "removed" },
        },
      ],
    },
    products,
  )
  expect(copy.title).toBe("登录小组")
  expect(copy.seats.map(({ name, role, duty, product, leader }) => ({ name, role, duty, product, leader }))).toEqual([
    { name: "小主", role: "组长", duty: "带队", product: "merak", leader: true },
    { name: "小红", role: "产品经理", duty: "写需求", product: "claude", leader: false },
  ])
  expect(new Set(copy.seats.map((seat) => seat.id)).size).toBe(2)
  expect(copy.skipped).toEqual(["小刚（Codex）", "小李（OpenCode）", "小王（gone）"])
})
