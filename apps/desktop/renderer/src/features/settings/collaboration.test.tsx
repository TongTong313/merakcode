import { type JSX } from "solid-js"
import { render } from "solid-js/web"
import { afterEach, beforeEach, expect, test } from "vitest"
import { setLocale } from "../../i18n"
import type { Product } from "../conversation/members"
import { ProductSettings } from "./collaboration"

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

const merak: Product = {
  id: "merak",
  title: "MerakCode",
  connected: true,
  enabled: true,
  builtin: true,
  source: "builtin",
}
const claude: Product = {
  id: "claude",
  title: "Claude Code",
  connected: true,
  enabled: true,
  builtin: true,
  source: "builtin",
  version: "2.0.1 (Claude Code)",
  path: "/usr/local/bin/claude",
  command: "claude",
  adapter: "claude",
  args: ["--model", "haiku"],
}
const codex: Product = {
  id: "codex",
  title: "Codex",
  connected: false,
  enabled: true,
  builtin: true,
  source: "builtin",
  reason: "spawn codex.exe ENOENT",
  command: "codex",
  adapter: "codex",
  args: [],
}
const opencode: Product = {
  id: "opencode",
  title: "OpenCode",
  connected: true,
  enabled: false,
  builtin: true,
  source: "global",
  command: "opencode",
  adapter: "opencode",
  args: [],
}
const theirs: Product = {
  id: "theirs",
  title: "Theirs",
  connected: true,
  enabled: true,
  builtin: false,
  source: "project",
  command: "theirs",
  args: [],
}

const button = (host: HTMLElement, name: string) =>
  [...host.querySelectorAll("button")].find((item) => item.textContent?.trim() === name)
const field = (host: HTMLElement, label: string) =>
  [...host.querySelectorAll("label")]
    .find((item) => item.textContent?.startsWith(label))!
    .querySelector("input, textarea") as HTMLInputElement
const type = (element: HTMLInputElement, value: string) => {
  element.value = value
  element.dispatchEvent(new InputEvent("input", { bubbles: true }))
}

/** The row of a product, found by its title */
const row = (host: HTMLElement, title: string) =>
  [...host.querySelectorAll<HTMLElement>(".setting-row")].find((item) =>
    item.querySelector(".label")?.textContent?.startsWith(title),
  )!

test("each product says whether it runs and why not, which version at which path, and where it is defined", () => {
  const host = mount(() => (
    <ProductSettings
      products={[merak, claude, codex, opencode, theirs]}
      onChange={async () => true}
      onRefresh={async () => {}}
    />
  ))
  expect(row(host, "MerakCode").textContent).toContain("群主")
  expect(row(host, "Claude Code").textContent).toContain("可用 · 2.0.1 (Claude Code) · /usr/local/bin/claude")
  expect(row(host, "Claude Code").textContent).toContain("内置")
  expect(row(host, "Codex").textContent).toContain("不可用 · spawn codex.exe ENOENT")
  expect(row(host, "OpenCode").textContent).toContain("已关闭")
  expect(row(host, "OpenCode").textContent).toContain("已修改")
  expect(row(host, "Theirs").textContent).toContain("项目配置")
})

test("each product says who decides its permissions: MerakCode for an adapter, the product itself for a one-shot command", () => {
  const mine: Product = { ...theirs, id: "mine", title: "Mine", source: "global", adapter: "member" }
  const plain: Product = { ...theirs, id: "plain", title: "Plain", adapter: "command" }
  const host = mount(() => (
    <ProductSettings
      products={[merak, claude, codex, theirs, mine, plain]}
      onChange={async () => true}
      onRefresh={async () => {}}
    />
  ))
  for (const title of ["Claude Code", "Codex", "Mine"])
    expect(row(host, title).textContent).toContain("权限：由 MerakCode 审批")
  for (const title of ["Theirs", "Plain"])
    expect(row(host, title).textContent).toContain("权限：由产品自己决定，不支持审批和提问")
  expect(row(host, "MerakCode").textContent).not.toContain("权限：")
})

test("a product is turned on and off by its switch; MerakCode has none, and one from the project's config is fixed", () => {
  const changes: unknown[] = []
  const host = mount(() => (
    <ProductSettings
      products={[merak, claude, opencode, theirs]}
      onChange={async (change) => {
        changes.push(change)
        return true
      }}
      onRefresh={async () => {}}
    />
  ))
  const toggle = (title: string) => row(host, title).querySelector<HTMLButtonElement>("[role=switch]")
  expect(toggle("MerakCode")).toBeNull()
  expect(toggle("Theirs")!.disabled).toBe(true)
  toggle("Claude Code")!.click()
  toggle("OpenCode")!.click()
  expect(changes).toEqual([
    { type: "enabled", id: "claude", enabled: false },
    { type: "enabled", id: "opencode", enabled: true },
  ])
})

test("a product is added with the same fields as in the config file, arguments one per line", async () => {
  const changes: unknown[] = []
  const host = mount(() => (
    <ProductSettings
      products={[merak, claude]}
      onChange={async (change) => {
        changes.push(change)
        return true
      }}
      onRefresh={async () => {}}
    />
  ))
  button(host, "添加产品")!.click()
  type(field(host, "ID"), "my-agent")
  type(field(host, "名称"), "My Agent")
  type(field(host, "命令"), "my-agent")
  type(field(host, "参数"), "run\n--json\n\n")
  type(field(host, "续接参数"), "run\n--session\n{id}")
  type(field(host, "会话 ID 匹配规则"), "session: (\S+)")
  button(host, "保存")!.click()
  expect(changes).toEqual([
    {
      type: "add",
      id: "my-agent",
      product: {
        title: "My Agent",
        command: "my-agent",
        args: ["run", "--json"],
        resumeArgs: ["run", "--session", "{id}"],
        sessionLine: "session: (\S+)",
      },
    },
  ])
  await Promise.resolve()
  expect(button(host, "保存")).toBeUndefined()
})

test("the form says what is wrong before it can be saved", () => {
  const host = mount(() => (
    <ProductSettings products={[merak, claude]} onChange={async () => true} onRefresh={async () => {}} />
  ))
  button(host, "添加产品")!.click()
  const save = () => button(host, "保存") as HTMLButtonElement
  type(field(host, "命令"), "x")
  for (const [id, problem] of [
    ["my agent", "ID 只能由字母、数字、- 和 _ 组成"],
    ["claude", "已有产品使用这个 ID"],
    ["merak", "已有产品使用这个 ID"],
  ]) {
    type(field(host, "ID"), id!)
    expect(host.textContent).toContain(problem)
    expect(save().disabled).toBe(true)
  }
  type(field(host, "ID"), "mine")
  expect(save().disabled).toBe(false)
  type(field(host, "命令"), " ")
  expect(host.textContent).toContain("请填写命令")
  expect(save().disabled).toBe(true)
  type(field(host, "命令"), "mine")
  type(field(host, "会话 ID 匹配规则"), "(")
  expect(host.textContent).toContain("会话 ID 匹配规则不是有效的正则表达式")
  expect(save().disabled).toBe(true)
})

test("a built-in product is edited with just its command and extra arguments, and keeps its id", () => {
  const changes: unknown[] = []
  const host = mount(() => (
    <ProductSettings
      products={[merak, claude, theirs]}
      onChange={async (change) => {
        changes.push(change)
        return true
      }}
      onRefresh={async () => {}}
    />
  ))
  const edit = (title: string) => row(host, title).querySelector<HTMLButtonElement>(`[aria-label="编辑 ${title}"]`)
  expect(edit("MerakCode")).toBeNull()
  expect(edit("Theirs")).toBeNull()
  edit("Claude Code")!.click()
  const labels = [...host.querySelectorAll("label")].map((item) => item.textContent ?? "")
  expect(labels.some((label) => label.startsWith("ID"))).toBe(false)
  expect(labels.some((label) => label.startsWith("续接参数"))).toBe(false)
  expect(labels.some((label) => label.startsWith("会话 ID 匹配规则"))).toBe(false)
  expect(field(host, "额外启动参数").value).toBe("--model\nhaiku")
  type(field(host, "命令"), "/opt/claude")
  button(host, "保存")!.click()
  expect(changes).toEqual([
    {
      type: "update",
      id: "claude",
      product: { title: "Claude Code", command: "/opt/claude", args: ["--model", "haiku"] },
    },
  ])
})

test("a custom product picks how MerakCode drives it; through an adapter it needs no one-shot settings", () => {
  const changes: unknown[] = []
  const host = mount(() => (
    <ProductSettings
      products={[merak, claude]}
      onChange={async (change) => {
        changes.push(change)
        return true
      }}
      onRefresh={async () => {}}
    />
  ))
  button(host, "添加产品")!.click()
  const select = host.querySelector<HTMLButtonElement>('button[aria-label^="接入方式"]')!
  expect(select.textContent).toContain("一次性命令")
  expect([...host.querySelectorAll("label")].some((item) => item.textContent?.startsWith("续接参数"))).toBe(true)
  select.dispatchEvent(new PointerEvent("pointerdown", { button: 0, bubbles: true, pointerType: "mouse" }))
  const member = [...document.querySelectorAll<HTMLElement>("[role=option]")].find((item) =>
    item.textContent?.includes("成员适配器"),
  )!
  member.dispatchEvent(new PointerEvent("pointerup", { button: 0, bubbles: true, pointerType: "mouse" }))
  member.click()
  expect([...host.querySelectorAll("label")].some((item) => item.textContent?.startsWith("续接参数"))).toBe(false)
  type(field(host, "ID"), "mine")
  type(field(host, "命令"), "node")
  type(field(host, "参数"), "/home/me/.merakcode/adapters/mine/adapter.mts")
  button(host, "保存")!.click()
  expect(changes).toEqual([
    {
      type: "add",
      id: "mine",
      product: { command: "node", adapter: "member", args: ["/home/me/.merakcode/adapters/mine/adapter.mts"] },
    },
  ])
})

test("an older CLI is shown with the version it should have and how to upgrade it", () => {
  const old: Product = {
    ...claude,
    version: "2.1.100",
    recommended: "2.1.283",
    upgrade: "claude update",
    outdated: true,
  }
  const host = mount(() => (
    <ProductSettings products={[merak, old]} onChange={async () => true} onRefresh={async () => {}} />
  ))
  expect(row(host, "Claude Code").textContent).toContain("建议升级")
  expect(row(host, "Claude Code").textContent).toContain("2.1.283")
  expect(row(host, "Claude Code").textContent).toContain("claude update")
})

test("a custom product can be removed and a modified built-in one restored to its default", () => {
  const changes: unknown[] = []
  const mine: Product = { ...theirs, id: "mine", title: "Mine", source: "global" }
  const host = mount(() => (
    <ProductSettings
      products={[merak, claude, opencode, theirs, mine]}
      onChange={async (change) => {
        changes.push(change)
        return true
      }}
      onRefresh={async () => {}}
    />
  ))
  const action = (title: string, name: string) =>
    row(host, title).querySelector<HTMLButtonElement>(`[aria-label="${name}"]`)
  for (const title of ["MerakCode", "Claude Code", "Theirs"]) {
    expect(action(title, `删除 ${title}`)).toBeNull()
    expect(action(title, `恢复 ${title} 的默认设置`)).toBeNull()
  }
  expect(action("Mine", `恢复 Mine 的默认设置`)).toBeNull()
  action("Mine", "删除 Mine")!.click()
  action("OpenCode", "恢复 OpenCode 的默认设置")!.click()
  expect(changes).toEqual([
    { type: "remove", id: "mine" },
    { type: "remove", id: "opencode" },
  ])
})

test("every CLI can be checked again, and the button waits for the check", async () => {
  let finish = () => {}
  let checks = 0
  const host = mount(() => (
    <ProductSettings
      products={[merak, claude]}
      onChange={async () => true}
      onRefresh={() => {
        checks++
        return new Promise<void>((resolve) => (finish = resolve))
      }}
    />
  ))
  button(host, "重新检测")!.click()
  expect(checks).toBe(1)
  expect((button(host, "正在检测…") as HTMLButtonElement).disabled).toBe(true)
  finish()
  await new Promise((resolve) => setTimeout(resolve))
  expect((button(host, "重新检测") as HTMLButtonElement).disabled).toBe(false)
})

test("MerakCode can be asked to write an adapter for a CLI it has none for", () => {
  let asked = 0
  const host = mount(() => (
    <ProductSettings
      products={[merak, claude]}
      onChange={async () => true}
      onRefresh={async () => {}}
      onGenerate={() => asked++}
    />
  ))
  button(host, "让 MerakCode 写适配器，帮你接入自己的 AI Coding 工具")!.click()
  expect(asked).toBe(1)
})
