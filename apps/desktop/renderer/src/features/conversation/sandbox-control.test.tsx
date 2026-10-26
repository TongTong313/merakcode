import { type JSX } from "solid-js"
import { render } from "solid-js/web"
import { afterEach, expect, test, vi } from "vitest"
import type { ProviderListResponses } from "@merakcode/sdk/client"
import { setLocale } from "../../i18n"
import { setState } from "../../state/store"
import { Toasts } from "../../ui/toast"
import { Composer } from "./composer"
import { changeSandbox, SandboxControl, SandboxField } from "./sandbox-control"

const requests: { url: string; body: string }[] = []
const http = vi.hoisted(() => ({ failInstall: false }))
vi.mock("undici", () => ({
  Agent: class {
    constructor() {}
  },
  fetch: async (url: string, init?: { body?: ArrayBuffer }) => {
    const body = init?.body ? new TextDecoder().decode(init.body) : ""
    requests.push({ url, body })
    if (http.failInstall && url.includes("/sandbox/install")) {
      return new Response(JSON.stringify({ message: "administrator approval was not given" }), {
        status: 500,
        headers: { "content-type": "application/json" },
      })
    }
    const payload = url.includes("/sandbox/install")
      ? { status: "on", backend: "windows-account" }
      : url.includes("/sandbox")
        ? { status: "unsupported", installable: true, reason: "needs a one-time setup" }
        : { sandbox: { mode: "preferred" } }
    return new Response(JSON.stringify(payload), {
      status: 200,
      headers: { "content-type": "application/json" },
    })
  },
}))

let cleanup = () => {}

afterEach(() => {
  cleanup()
  cleanup = () => {}
  http.failInstall = false
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

function open(host: HTMLElement) {
  host
    .querySelector("button")
    ?.dispatchEvent(new PointerEvent("pointerdown", { button: 0, bubbles: true, pointerType: "mouse" }))
  return [...document.querySelectorAll("[role=option]")].map((item) => item.textContent ?? "")
}

test("the reasoning control keeps the current level beside its icon and says what it configures", async () => {
  setLocale("zh")
  const model = {
    release_date: "2026-01-01",
    attachment: false,
    reasoning: true,
    temperature: true,
    tool_call: true,
    options: {},
    limit: { context: 1000, output: 100 },
    variants: { low: {}, high: {} },
    defaultVariant: "high",
  }
  setState("providers", {
    all: [
      {
        id: "anthropic",
        name: "Anthropic",
        origin: "official",
        env: [],
        models: { claude: { ...model, id: "claude", name: "Claude", homepage: true } },
      },
    ],
    connected: ["anthropic"],
    default: { anthropic: "claude" },
  } as unknown as ProviderListResponses[200])
  vi.useFakeTimers()
  try {
    const host = mount(() => <Composer directory="/proj" busy={false} onSubmit={() => {}} />)
    const button = [...host.querySelectorAll("button")].find((item) => item.querySelector(".lucide-brain"))
    expect(button?.textContent).toContain("high")
    expect(button?.getAttribute("aria-label")).toBe("配置思考强度，high")
    button?.dispatchEvent(new PointerEvent("pointerenter", { bubbles: true, pointerType: "mouse" }))
    await vi.advanceTimersByTimeAsync(500)
    expect(document.querySelector(".tooltip")?.textContent).toBe("配置思考强度")
    button?.dispatchEvent(new PointerEvent("pointerdown", { button: 0, bubbles: true, pointerType: "mouse" }))
    const options = [...document.querySelectorAll("[role=option]")].map((item) => item.textContent ?? "")
    expect(options).toEqual(["low", "high"])
  } finally {
    vi.useRealTimers()
    setState({ providers: undefined })
  }
})

test("usage, the model and the permission mode use the same hint above the control", async () => {
  setLocale("zh")
  const model = {
    release_date: "2026-01-01",
    attachment: false,
    reasoning: true,
    temperature: true,
    tool_call: true,
    options: {},
    limit: { context: 1000, output: 100 },
    variants: { high: {} },
    defaultVariant: "high",
  }
  setState("providers", {
    all: [
      {
        id: "anthropic",
        name: "Anthropic",
        origin: "official",
        env: [],
        models: { claude: { ...model, id: "claude", name: "Claude", homepage: true } },
      },
    ],
    connected: ["anthropic"],
    default: { anthropic: "claude" },
  } as unknown as ProviderListResponses[200])
  setState("sessions", "message", "s-usage", [
    {
      id: "a1",
      sessionID: "s-usage",
      role: "assistant",
      time: { created: 2 },
      parentID: "user",
      modelID: "claude",
      providerID: "anthropic",
      mode: "build",
      agent: "build",
      path: { cwd: "/", root: "/" },
      cost: 0,
      tokens: { input: 10, output: 10, reasoning: 0, cache: { read: 0, write: 0 } },
    },
  ])
  vi.useFakeTimers()
  try {
    const host = mount(() => <Composer directory="/proj" sessionID="s-usage" busy={false} onSubmit={() => {}} />)
    const hint = async (target: Element | null | undefined) => {
      document.querySelector(".tooltip")?.remove()
      target?.dispatchEvent(new PointerEvent("pointerenter", { bubbles: true, pointerType: "mouse" }))
      await vi.advanceTimersByTimeAsync(500)
      return document.querySelector(".tooltip")?.textContent ?? ""
    }
    const usage = host.querySelector(".usage")
    expect(usage?.hasAttribute("title")).toBe(false)
    const usageHint = await hint(usage)
    expect(usageHint).toContain("上下文")
    expect(usageHint).toContain("20")
    const modelButton = [...host.querySelectorAll("button")].find((item) => item.textContent?.includes("Claude"))
    expect(modelButton?.getAttribute("aria-label")).toBe("配置模型，Claude")
    expect(await hint(modelButton)).toBe("配置模型")
    const modeButton = [...host.querySelectorAll("button")].find((item) => item.textContent?.includes("询问"))
    expect(modeButton?.getAttribute("aria-label")).toBe("配置权限模式，询问")
    expect(await hint(modeButton)).toBe("配置权限模式")
  } finally {
    vi.useRealTimers()
    setState({ providers: undefined })
    setState("sessions", "message", "s-usage", [])
  }
})

test("preparing the sandbox menu reads the state again", async () => {
  requests.length = 0
  const host = mount(() => <SandboxField directory="/proj" />)
  const statusRequests = () =>
    requests.filter((item) => item.url.includes("/sandbox") && !item.url.includes("/install"))
  await vi.waitFor(() => expect(statusRequests().length).toBeGreaterThan(0))
  const before = statusRequests().length
  host.querySelector("button")?.dispatchEvent(new PointerEvent("pointerenter", { bubbles: true, pointerType: "mouse" }))
  await vi.waitFor(() => expect(statusRequests().length).toBe(before + 1))
})

test("a failed setup shows the error and leaves the sandbox mode unchanged", async () => {
  setLocale("zh")
  http.failInstall = true
  requests.length = 0
  const host = mount(() => (
    <>
      <SandboxField directory="/proj" />
      <Toasts />
    </>
  ))
  await vi.waitFor(() => expect(host.textContent).toContain("关"))
  host
    .querySelector("button")
    ?.dispatchEvent(new PointerEvent("pointerdown", { button: 0, bubbles: true, pointerType: "mouse" }))
  const option = [...document.querySelectorAll("[role=option]")].find((item) => item.textContent?.includes("初始化"))
  option?.dispatchEvent(new MouseEvent("click", { bubbles: true }))
  await vi.waitFor(() => expect(document.body.textContent).toContain("请求失败：administrator approval was not given"))
  expect(requests.some((item) => item.url.includes("/global/config"))).toBe(false)
})

test("the composer shows the sandbox control", () => {
  setLocale("zh")
  const host = mount(() => <Composer directory="/proj" busy={false} onSubmit={() => {}} />)
  const button = [...host.querySelectorAll("button")].find((item) => item.querySelector(".lucide-shield"))
  expect(button?.textContent?.trim()).toBe("")
  expect(button?.getAttribute("aria-label")).toBe("配置沙箱")
})

test("turning the sandbox off or on writes the global mode without restarting the conversation, and setup installs it", async () => {
  requests.length = 0
  await changeSandbox("/proj", "off")
  await changeSandbox("/proj", "preferred")
  await changeSandbox("/proj", "install")
  const config = requests.filter((item) => item.url.includes("/global/config"))
  expect(config).toHaveLength(3)
  for (const item of config) expect(item.url).toContain("skipDispose=true")
  expect(config[0]?.body).toContain('"off"')
  expect(config[1]?.body).toContain('"preferred"')
  expect(requests.some((item) => item.url.includes("/sandbox/install"))).toBe(true)
  expect(config[2]?.body).toContain('"preferred"')
})

test("choosing setup, turning on, or turning off runs that action", () => {
  setLocale("zh")
  const actions: string[] = []
  const choose = (label: string) => {
    const option = [...document.querySelectorAll("[role=option]")].find((item) => item.textContent?.includes(label))
    option?.dispatchEvent(new MouseEvent("click", { bubbles: true }))
  }
  const uninitialized = mount(() => (
    <SandboxControl
      status={{ status: "unsupported", installable: true }}
      busy={false}
      onInstall={() => actions.push("install")}
      onMode={(mode) => actions.push(mode)}
    />
  ))
  open(uninitialized)
  choose("初始化")
  choose("关闭")
  cleanup()
  cleanup = () => {}
  const off = mount(() => (
    <SandboxControl
      status={{ status: "off", backend: "landlock" }}
      busy={false}
      onInstall={() => {}}
      onMode={(mode) => actions.push(mode)}
    />
  ))
  open(off)
  choose("开启")
  expect(actions).toEqual(["install", "off", "preferred"])
})

test("hovering the sandbox control says that it configures the sandbox", async () => {
  setLocale("zh")
  const host = mount(() => (
    <SandboxControl
      status={{ status: "on", backend: "windows-account" }}
      busy={false}
      onInstall={() => {}}
      onMode={() => {}}
    />
  ))
  const button = host.querySelector("button")
  const trigger = button?.closest(".tip") as HTMLElement | null
  const box = {
    x: 480,
    y: 720,
    width: 72,
    height: 28,
    top: 720,
    left: 480,
    right: 552,
    bottom: 748,
    toJSON() {
      return {}
    },
  } as DOMRect
  if (button) button.getBoundingClientRect = () => box
  if (trigger) {
    const own = trigger.getBoundingClientRect.bind(trigger)
    trigger.getBoundingClientRect = () => (getComputedStyle(trigger).display === "contents" ? own() : box)
  }
  button?.dispatchEvent(new PointerEvent("pointerenter", { bubbles: true, pointerType: "mouse" }))
  await vi.waitFor(() => {
    const hint = document.querySelector<HTMLElement>(".tooltip")
    expect(hint?.textContent).toBe("配置沙箱")
    const placed = [...document.querySelectorAll<HTMLElement>("body *")].find((item) =>
      item.style.transform.includes("translate3d"),
    )
    const y = Number(placed?.style.transform.match(/translate3d\([^,]+,\s*(-?\d+(?:\.\d+)?)px/)?.[1])
    expect(y).toBeLessThan(box.top)
  })
})

test("setup in progress disables the sandbox control", () => {
  setLocale("zh")
  const host = mount(() => (
    <SandboxControl status={{ status: "unsupported", installable: true }} busy onInstall={() => {}} onMode={() => {}} />
  ))
  const button = host.querySelector("button")
  expect(button?.textContent?.trim()).toBe("关")
  expect(button?.getAttribute("aria-label")).toBe("配置沙箱，关")
  expect(button?.querySelector(".lucide-shield")).toBeTruthy()
  expect(button?.hasAttribute("disabled")).toBe(true)
})

test("an unavailable sandbox shows why and offers turning it off", () => {
  setLocale("zh")
  const host = mount(() => (
    <SandboxControl
      status={{ status: "unsupported", reason: "csc.exe is missing" }}
      busy={false}
      onInstall={() => {}}
      onMode={() => {}}
    />
  ))
  const button = host.querySelector("button")
  expect(button?.textContent?.trim()).toBe("关")
  expect(button?.getAttribute("aria-label")).toBe("配置沙箱，关")
  expect(button?.querySelector(".lucide-shield")).toBeTruthy()
  const options = open(host)
  expect(options.some((item) => item.includes("csc.exe is missing"))).toBe(true)
  expect(options.some((item) => item.includes("关闭"))).toBe(true)
  expect(options.some((item) => item.includes("初始化"))).toBe(false)
  expect(options.some((item) => item.includes("开启"))).toBe(false)
})

test("a sandbox that is turned off, and already set up, offers turning it on", () => {
  setLocale("zh")
  const host = mount(() => (
    <SandboxControl
      status={{ status: "off", backend: "windows-account" }}
      busy={false}
      onInstall={() => {}}
      onMode={() => {}}
    />
  ))
  const button = host.querySelector("button")
  expect(button?.textContent?.trim()).toBe("关")
  expect(button?.getAttribute("aria-label")).toBe("配置沙箱，关")
  expect(button?.querySelector(".lucide-shield")).toBeTruthy()
  const options = open(host)
  expect(options.some((item) => item.includes("开启"))).toBe(true)
  expect(options.some((item) => item.includes("初始化"))).toBe(false)
  expect(options.some((item) => item.includes("关闭"))).toBe(false)
})

test("a running sandbox shows that it is on and only offers turning it off", () => {
  setLocale("zh")
  const host = mount(() => (
    <SandboxControl
      status={{ status: "on", backend: "windows-account" }}
      busy={false}
      onInstall={() => {}}
      onMode={() => {}}
    />
  ))
  const button = host.querySelector("button")
  expect(button?.textContent?.trim()).toBe("开")
  expect(button?.getAttribute("aria-label")).toBe("配置沙箱，开")
  expect(button?.querySelector(".lucide-shield")).toBeTruthy()
  const options = open(host)
  expect(options.some((item) => item.includes("关闭"))).toBe(true)
  expect(options.some((item) => item.includes("初始化"))).toBe(false)
  expect(options.some((item) => item.includes("开启"))).toBe(false)
})

test("an uninitialized sandbox shows that state and offers setup or turning it off", () => {
  setLocale("zh")
  const host = mount(() => (
    <SandboxControl
      status={{ status: "unsupported", installable: true, reason: "needs a one-time setup" }}
      busy={false}
      onInstall={() => {}}
      onMode={() => {}}
    />
  ))
  const button = host.querySelector("button")
  expect(button?.textContent?.trim()).toBe("关")
  expect(button?.getAttribute("aria-label")).toBe("配置沙箱，关")
  expect(button?.querySelector(".lucide-shield")).toBeTruthy()
  const options = open(host)
  expect(options.some((item) => item.includes("初始化"))).toBe(true)
  expect(options.some((item) => item.includes("关闭"))).toBe(true)
  expect(options.some((item) => item.includes("开启"))).toBe(false)
})
