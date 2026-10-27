import { connectionDefaults } from "./product.fixture"
import type { CollaborationGroupSummary } from "@merakcode/sdk/client"
import { type JSX } from "solid-js"
import { render } from "solid-js/web"
import { afterEach, beforeEach, expect, test } from "vitest"
import { setLocale, t } from "../../i18n"
import { GroupCreate } from "./group-create"
import type { Product } from "./members"

let cleanup = () => {}

beforeEach(() => setLocale("zh"))

afterEach(() => {
  cleanup()
  cleanup = () => {}
})

function mount(node: () => JSX.Element) {
  const host = document.createElement("div")
  document.body.appendChild(host)
  const dispose = render(node, host)
  cleanup = () => {
    dispose()
    host.remove()
  }
  return host
}

const settled = () => new Promise((resolve) => setTimeout(resolve, 0))

const products: Product[] = [
  {
    id: "merak",
    title: "MerakCode",
    connected: true,
    enabled: true,
    builtin: true,
    source: "builtin",
    ...connectionDefaults,
  },
  {
    id: "claude",
    title: "Claude Code",
    connected: true,
    enabled: true,
    builtin: true,
    source: "builtin",
    ...connectionDefaults,
  },
  {
    id: "codex",
    title: "Codex",
    connected: false,
    enabled: true,
    builtin: true,
    source: "builtin",
    ...connectionDefaults,
  },
]

const groups: CollaborationGroupSummary[] = [
  {
    sessionID: "g1",
    title: "蜂群",
    directory: "D:\\tmp\\swarm",
    seats: [
      { name: "小主", role: "", duty: "负责分派", product: "merak", leader: true, availability: { state: "online" } },
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
    ],
  },
  {
    sessionID: "g2",
    title: "自制适配器试跑",
    directory: "D:\\tmp\\skill-run\\project3",
    seats: [{ name: "小主", role: "", duty: "", product: "merak", leader: true, availability: { state: "online" } }],
  },
]

const dialog = () => document.querySelector<HTMLElement>("[role=dialog]")!
const nameInput = () =>
  [...dialog().querySelectorAll("label")]
    .find((item) => item.textContent?.startsWith(t("group.name")))!
    .querySelector("input") as HTMLInputElement
const memberNames = () =>
  [...dialog().querySelectorAll<HTMLButtonElement>(".member-row")].map(
    (row) => row.querySelector(".member-name .ellipsis")?.textContent?.trim() ?? "",
  )
const copyTrigger = () => dialog().querySelector<HTMLButtonElement>(`button[aria-label="${t("group.copyFrom")}"]`)!
const clearButton = () =>
  [...dialog().querySelectorAll("button")].find((item) => item.textContent?.trim() === t("group.copyClear"))
const openCopyMenu = () => {
  copyTrigger().dispatchEvent(new PointerEvent("pointerdown", { button: 0, bubbles: true, pointerType: "mouse" }))
}
const optionLabels = () =>
  [...document.querySelectorAll<HTMLElement>("[role=option]")].map(
    (item) => item.textContent?.replace(/\s+/g, " ").trim() ?? "",
  )

function openCreate() {
  return mount(() => (
    <GroupCreate
      directory="/project"
      open
      products={products}
      groups={groups}
      onClose={() => {}}
      onCreated={() => {}}
    />
  ))
}

const pickGroup = async (title: string) => {
  openCopyMenu()
  await settled()
  const option = [...document.querySelectorAll<HTMLElement>("[role=option]")].find((item) =>
    item.textContent?.includes(title),
  )
  option!.click()
  await settled()
}

test("on open the copy field lists only existing groups, has no clear control, and the form is a blank draft", async () => {
  openCreate()
  await settled()
  expect(nameInput().value).toBe("")
  expect(memberNames()).toEqual([t("group.defaultLeader")])
  expect(clearButton()).toBeUndefined()
  expect(copyTrigger().textContent).toContain(t("group.copyFromPlaceholder"))
  openCopyMenu()
  const labels = optionLabels()
  expect(labels.some((label) => label.includes("蜂群"))).toBe(true)
  expect(labels.some((label) => label.includes("自制适配器试跑"))).toBe(true)
  expect(labels.some((label) => label.includes(t("group.copyClear")))).toBe(false)
})

test("picking a group fills the form and shows a clear control beside the select", async () => {
  openCreate()
  await settled()
  await pickGroup("蜂群")
  expect(nameInput().value).toBe("蜂群")
  expect(memberNames()).toEqual(["小主", "小红"])
  expect(copyTrigger().textContent).toContain("蜂群")
  expect(clearButton()).toBeDefined()
})

test("clearing after a copy restores the blank draft and hides the clear control", async () => {
  openCreate()
  await settled()
  await pickGroup("蜂群")
  expect(dialog().querySelector(".group-copy-skipped")?.textContent).toContain("小刚")
  clearButton()!.click()
  await settled()
  expect(nameInput().value).toBe("")
  expect(memberNames()).toEqual([t("group.defaultLeader")])
  expect(copyTrigger().textContent).toContain(t("group.copyFromPlaceholder"))
  expect(clearButton()).toBeUndefined()
  expect(dialog().querySelector(".group-copy-skipped")).toBeNull()
})

test("clearing after editing a copied name discards the hand edits too", async () => {
  openCreate()
  await settled()
  await pickGroup("蜂群")
  const input = nameInput()
  input.value = "手改的名字"
  input.dispatchEvent(new InputEvent("input", { bubbles: true }))
  expect(nameInput().value).toBe("手改的名字")
  clearButton()!.click()
  await settled()
  expect(nameInput().value).toBe("")
  expect(memberNames()).toEqual([t("group.defaultLeader")])
  expect(clearButton()).toBeUndefined()
})
