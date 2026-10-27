import { connectionDefaults } from "../conversation/product.fixture"
import { createSignal, type JSX } from "solid-js"
import { render } from "solid-js/web"
import { afterEach, beforeEach, expect, test } from "vitest"
import { setLocale } from "../../i18n"
import type { Product } from "../conversation/members"
import { ProductSettings } from "./agent-connections"
import type { AgentConnectionVerification } from "@merakcode/sdk/client"
import { MerakCodeError } from "@merakcode/sdk/errors"

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
  ...connectionDefaults,
}
const claude: Product = {
  id: "claude",
  title: "Claude Code",
  connected: true,
  enabled: true,
  builtin: true,
  source: "builtin",
  ...connectionDefaults,
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
  ...connectionDefaults,
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
  ...connectionDefaults,
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
  source: "global",
  ...connectionDefaults,
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

test.each([
  ["zh", "权限：由产品自己决定", "权限：由 MerakCode 审批", "不支持审批和提问"],
  ["en", "Permissions: decided by the product", "Permissions: approved in MerakCode", "cannot ask"],
] as const)("a custom member describes its reported permission ownership in %s", (locale, own, merak, unsupported) => {
  setLocale(locale)
  const host = mount(() => (
    <ProductSettings
      products={[{ ...theirs, adapter: "member", capabilities: { ...theirs.capabilities, questions: true } }]}
      onChange={async () => true}
      onRefresh={async () => {}}
    />
  ))
  expect(row(host, "Theirs").textContent).toContain(own)
  expect(row(host, "Theirs").textContent).not.toContain(merak)
  expect(row(host, "Theirs").textContent).not.toContain(unsupported)
})

test.each([
  ["zh", "权限："],
  ["en", "Permissions:"],
] as const)("unavailable products do not assert unverified permissions in %s", (locale, label) => {
  setLocale(locale)
  const host = mount(() => (
    <ProductSettings
      products={[
        { ...theirs, adapter: "member", connected: false },
        { ...claude, connected: false, capabilities: { ...claude.capabilities, permission: "merak" } },
      ]}
      onChange={async () => true}
      onRefresh={async () => {}}
    />
  ))
  expect(host.textContent).not.toContain(label)
})

test("a failed verification report keeps its visible error code and reason", async () => {
  const host = mount(() => (
    <ProductSettings
      products={[claude]}
      onChange={async () => true}
      onRefresh={async () => {}}
      onVerify={async () => ({
        productID: claude.id,
        revision: claude.revision,
        status: "failed",
        streamingObserved: false,
        checkedAt: 1,
        error: { code: "MRK-4009", message: "Synthetic model refusal" },
      })}
    />
  ))
  row(host, "Claude Code").querySelector<HTMLButtonElement>('[aria-label="验证 Claude Code"]')!.click()
  await expect.poll(() => host.textContent).toContain("Synthetic model refusal")
  expect(host.textContent).toContain("MRK-4009")
})

test("a rejected verification request keeps its visible error code and request ID", async () => {
  const host = mount(() => (
    <ProductSettings
      products={[claude]}
      onChange={async () => true}
      onRefresh={async () => {}}
      onVerify={async () => {
        throw new MerakCodeError({
          code: "MRK-1004",
          message: "Synthetic request refusal",
          requestID: "verify-request",
        })
      }}
    />
  ))
  row(host, "Claude Code").querySelector<HTMLButtonElement>('[aria-label="验证 Claude Code"]')!.click()
  await expect.poll(() => host.textContent).toContain("Synthetic request refusal")
  expect(host.textContent).toContain("MRK-1004")
  expect(host.textContent).toContain("verify-request")
})

test("a model discovery failure keeps its visible error code", async () => {
  setLocale("en")
  const host = mount(() => (
    <ProductSettings
      products={[claude]}
      onChange={async () => true}
      onRefresh={async () => {}}
      onModels={async () => {
        throw new MerakCodeError({ code: "MRK-1004", message: "Synthetic discovery failure" })
      }}
    />
  ))
  row(host, "Claude Code").querySelector<HTMLButtonElement>('[aria-label="Edit Claude Code"]')!.click()
  button(host, "Load model list")!.click()
  await expect.poll(() => host.textContent).toContain("Synthetic discovery failure")
  expect(host.textContent).toContain("MRK-1004")
})

test("each product says whether it runs and why not, which version at which path, and where it is defined", () => {
  const host = mount(() => (
    <ProductSettings
      products={[merak, claude, codex, opencode, theirs]}
      onChange={async () => true}
      onRefresh={async () => {}}
    />
  ))
  expect(row(host, "MerakCode").textContent).toContain("本产品 · 默认开启")
  expect(row(host, "Claude Code").textContent).toContain("可用 · 2.0.1 (Claude Code) · /usr/local/bin/claude")
  expect(row(host, "Claude Code").textContent).toContain("内置")
  expect(row(host, "Codex").textContent).toContain("不可用 · spawn codex.exe ENOENT")
  expect(row(host, "OpenCode").textContent).toContain("已关闭")
  expect(row(host, "OpenCode").textContent).toContain("已修改")
  expect(row(host, "Theirs").textContent).toContain("自定义")
})

test.each([
  ["zh", "完成后输出"],
  ["en", "Output on completion"],
] as const)("a product without text streaming explains its output timing in %s", (locale, label) => {
  setLocale(locale)
  const host = mount(() => (
    <ProductSettings
      products={[
        merak,
        { ...theirs, title: "Command", adapter: "command" },
        { ...claude, capabilities: { ...claude.capabilities, textStreaming: true } },
      ]}
      onChange={async () => true}
      onRefresh={async () => {}}
    />
  ))
  expect(row(host, "Command").textContent).toContain(label)
  expect(row(host, "Claude Code").textContent).not.toContain(label)
  expect(row(host, "MerakCode").textContent).not.toContain(label)
})

test.each([
  ["zh", "完成后输出"],
  ["en", "Output on completion"],
] as const)("unavailable products do not claim a confirmed output capability in %s", (locale, label) => {
  setLocale(locale)
  const host = mount(() => (
    <ProductSettings
      products={[
        { ...claude, connected: false },
        { ...opencode, connected: false },
      ]}
      onChange={async () => true}
      onRefresh={async () => {}}
    />
  ))
  expect(row(host, "Claude Code").textContent).not.toContain(label)
  expect(row(host, "OpenCode").textContent).not.toContain(label)
})

test("each connected product reports the permission owner declared by its adapter", () => {
  const mine: Product = {
    ...theirs,
    id: "mine",
    title: "Mine",
    source: "global",
    ...connectionDefaults,
    adapter: "member",
    capabilities: { ...connectionDefaults.capabilities, permission: "merak" },
  }
  const plain: Product = { ...theirs, id: "plain", title: "Plain", adapter: "command" }
  const host = mount(() => (
    <ProductSettings
      products={[
        merak,
        { ...claude, capabilities: { ...claude.capabilities, permission: "merak" } },
        { ...codex, connected: true, capabilities: { ...codex.capabilities, permission: "merak" } },
        theirs,
        mine,
        plain,
      ]}
      onChange={async () => true}
      onRefresh={async () => {}}
    />
  ))
  for (const title of ["Claude Code", "Codex", "Mine"])
    expect(row(host, title).textContent).toContain("权限：由 MerakCode 审批")
  for (const title of ["Theirs", "Plain"]) expect(row(host, title).textContent).toContain("权限：由产品自己决定")
  expect(row(host, "MerakCode").textContent).not.toContain("权限：")
})

test("a global product is turned on and off by its switch while MerakCode has none", () => {
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
  expect(toggle("Theirs")!.disabled).toBe(false)
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
  expect(edit("Theirs")).not.toBeNull()
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
  const mine: Product = { ...theirs, id: "mine", title: "Mine", source: "global", ...connectionDefaults }
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
  for (const title of ["MerakCode", "Claude Code"]) {
    expect(action(title, `删除 ${title}`)).toBeNull()
    expect(action(title, `恢复 ${title} 的默认设置`)).toBeNull()
  }
  expect(action("Mine", `恢复 Mine 的默认设置`)).toBeNull()
  action("Mine", "删除 Mine")!.click()
  action("OpenCode", "恢复 OpenCode 的默认设置")!.click()
  expect(changes).toEqual([
    { type: "remove", id: "mine" },
    { type: "update", id: "opencode", product: {} },
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

test("a product saves an explicit model independently of command arguments", () => {
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
  row(host, "Claude Code").querySelector<HTMLButtonElement>('[aria-label="编辑 Claude Code"]')!.click()
  const model = [...host.querySelectorAll("label")].find((item) => item.textContent?.startsWith("模型 ID"))
  expect(model).toBeDefined()
  type(model!.querySelector("input")!, "haiku")
  type(field(host, "额外启动参数"), "")
  button(host, "保存")!.click()
  expect(changes).toEqual([
    {
      type: "update",
      id: "claude",
      product: { title: "Claude Code", command: "claude", args: undefined, model: { id: "haiku" } },
    },
  ])
})

test("verification displays the reported model and is cleared when saved configuration changes", async () => {
  const [products, setProducts] = createSignal([merak, claude])
  const host = mount(() => (
    <ProductSettings
      products={products()}
      onChange={async () => true}
      onRefresh={async () => {}}
      onVerify={async (product) => ({
        productID: product.id,
        revision: product.revision,
        status: "passed",
        actualModel: { id: "reported-haiku" },
        streamingObserved: true,
        checkedAt: 1,
      })}
    />
  ))
  const verify = row(host, "Claude Code").querySelector<HTMLButtonElement>('[aria-label="验证 Claude Code"]')
  expect(verify).not.toBeNull()
  verify!.click()
  await Promise.resolve()
  expect(host.textContent).toContain("reported-haiku")
  expect(host.textContent).toContain("已观察到流式正文")
  setProducts([merak, { ...claude, revision: 1 }])
  expect(host.textContent).not.toContain("reported-haiku")
})

test.each([false, true])("editing a model discards late verification (rejected: %s)", async (rejected) => {
  const pending = Promise.withResolvers<AgentConnectionVerification>()
  const host = mount(() => (
    <ProductSettings
      products={[merak, claude]}
      onChange={async () => true}
      onRefresh={async () => {}}
      onVerify={() => pending.promise}
    />
  ))
  const productRow = row(host, "Claude Code")
  const verify = productRow.querySelector<HTMLButtonElement>('[aria-label="验证 Claude Code"]')!
  verify.click()
  productRow.querySelector<HTMLButtonElement>('[aria-label="编辑 Claude Code"]')!.click()
  type(field(host, "模型 ID"), "unverified-draft-model")
  if (rejected) pending.reject(new Error("Old verification error"))
  else
    pending.resolve({
      productID: claude.id,
      revision: claude.revision,
      status: "passed",
      actualModel: { id: "old-verified-model" },
      streamingObserved: true,
      checkedAt: 1,
    })
  await pending.promise.catch(() => undefined)
  expect(productRow.textContent).not.toContain("old-verified-model")
  expect(productRow.textContent).not.toContain("验证通过")
  expect(productRow.textContent).not.toContain("Old verification error")
  expect(field(host, "模型 ID").value).toBe("unverified-draft-model")
  button(host, "取消")!.click()
  expect(verify.disabled).toBe(false)
})

test("refresh invalidates pending verification even when the product revision stays the same", async () => {
  const pending = Promise.withResolvers<AgentConnectionVerification>()
  const refreshed = Promise.withResolvers<void>()
  const host = mount(() => (
    <ProductSettings
      products={[merak, claude]}
      onChange={async () => true}
      onRefresh={() => refreshed.promise}
      onVerify={() => pending.promise}
    />
  ))
  const productRow = row(host, "Claude Code")
  productRow.querySelector<HTMLButtonElement>('[aria-label="验证 Claude Code"]')!.click()
  button(host, "重新检测")!.click()
  pending.resolve({
    productID: claude.id,
    revision: claude.revision,
    status: "passed",
    actualModel: { id: "before-refresh-model" },
    streamingObserved: true,
    checkedAt: 1,
  })
  await pending.promise
  expect(productRow.textContent).not.toContain("before-refresh-model")
  refreshed.resolve()
  await refreshed.promise
})

test("changing a product invalidates verification before the saved configuration returns", async () => {
  const pending = Promise.withResolvers<AgentConnectionVerification>()
  const changed = Promise.withResolvers<boolean>()
  const host = mount(() => (
    <ProductSettings
      products={[merak, claude]}
      onChange={() => changed.promise}
      onRefresh={async () => {}}
      onVerify={() => pending.promise}
    />
  ))
  const productRow = row(host, "Claude Code")
  productRow.querySelector<HTMLButtonElement>('[aria-label="验证 Claude Code"]')!.click()
  productRow.querySelector<HTMLElement>('[role="switch"]')!.click()
  pending.resolve({
    productID: claude.id,
    revision: claude.revision,
    status: "passed",
    actualModel: { id: "before-change-model" },
    streamingObserved: true,
    checkedAt: 1,
  })
  await pending.promise
  expect(productRow.textContent).not.toContain("before-change-model")
  changed.resolve(true)
  await changed.promise
})

test("a fresh verification works after a pending report is invalidated by new configuration", async () => {
  const pending = Promise.withResolvers<AgentConnectionVerification>()
  const [products, setProducts] = createSignal([merak, claude])
  const host = mount(() => (
    <ProductSettings
      products={products()}
      onChange={async () => true}
      onRefresh={async () => {}}
      onVerify={(product) =>
        product.revision === claude.revision
          ? pending.promise
          : Promise.resolve({
              productID: product.id,
              revision: product.revision,
              status: "passed",
              actualModel: { id: "fresh-model" },
              streamingObserved: true,
              checkedAt: 2,
            })
      }
    />
  ))
  const verify = () => row(host, "Claude Code").querySelector<HTMLButtonElement>('[aria-label="验证 Claude Code"]')!
  verify().click()
  setProducts([merak, { ...claude, revision: claude.revision + 1 }])
  expect(verify().disabled).toBe(true)
  pending.resolve({
    productID: claude.id,
    revision: claude.revision,
    status: "passed",
    actualModel: { id: "superseded-model" },
    streamingObserved: true,
    checkedAt: 1,
  })
  await pending.promise
  expect(host.textContent).not.toContain("superseded-model")
  expect(verify().disabled).toBe(false)
  verify().click()
  await Promise.resolve()
  expect(row(host, "Claude Code").textContent).toContain("fresh-model")
})

test("discovered models fill the model field without claiming verification", async () => {
  const host = mount(() => (
    <ProductSettings
      products={[merak, claude]}
      onChange={async () => true}
      onRefresh={async () => {}}
      onModels={async () => ({ models: [{ id: "sonnet", title: "Sonnet" }], allowCustomID: true })}
    />
  ))
  row(host, "Claude Code").querySelector<HTMLButtonElement>('[aria-label="编辑 Claude Code"]')!.click()
  const load = button(host, "读取模型列表")
  expect(load).toBeDefined()
  load!.click()
  await Promise.resolve()
  const picker = host.querySelector<HTMLButtonElement>('button[aria-label="模型列表"]')!
  picker.dispatchEvent(new PointerEvent("pointerdown", { button: 0, bubbles: true, pointerType: "mouse" }))
  const option = [...document.querySelectorAll<HTMLElement>('[role="option"]')].find(
    (item) => item.textContent === "Sonnet",
  )!
  option.dispatchEvent(new PointerEvent("pointerup", { button: 0, bubbles: true, pointerType: "mouse" }))
  option.click()
  expect(field(host, "模型 ID").value).toBe("sonnet")
  expect(host.textContent).not.toContain("验证通过")
})
