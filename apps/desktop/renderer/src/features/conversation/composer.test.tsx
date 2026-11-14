import { createSignal } from "solid-js"
import { render } from "solid-js/web"
import { afterEach, beforeEach, expect, test, vi } from "vitest"
import { setLocale } from "../../i18n"
import { Composer, modeOptions } from "./composer"
import { send } from "./send"
import { setState } from "../../state/store"
import { Toasts } from "../../ui/toast"

const png =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Zl1sAAAAASUVORK5CYII="

let cleanup = () => {}
beforeEach(() => setLocale("zh"))

test("a migrated conversation shows its permission change notice once across composer reopen", async () => {
  const id = "ses_permission_migration"
  localStorage.removeItem(`ui:permission-migration:${id}`)
  setState("sessions", "session", [
    {
      id,
      slug: id,
      projectID: "global",
      directory: "/migration",
      title: "Migrated",
      version: "1",
      time: { created: 1, updated: 1 },
      permissionLevel: "ask",
      permissionNotice: "legacy-permissions-reset",
    },
  ])
  const host = document.createElement("div")
  document.body.append(host)
  const mount = () =>
    render(
      () => (
        <>
          <Composer sessionID={id} directory="/migration" busy={false} onSubmit={() => {}} />
          <Toasts />
        </>
      ),
      host,
    )
  let dispose = mount()
  try {
    await vi.waitFor(() => expect(host.textContent).toContain("旧权限已改为每次询问"))
    dispose()
    dispose = mount()
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(host.textContent?.split("旧权限已改为每次询问").length).toBe(2)
  } finally {
    dispose()
    host.remove()
    setState("sessions", "session", [])
  }
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

function renderImageDraft(directory: string) {
  const host = document.createElement("div")
  document.body.appendChild(host)
  const dispose = render(
    () => (
      <Composer
        directory={directory}
        busy={false}
        draft={{
          text: "",
          files: [{ type: "file", mime: "image/png", filename: "shot.png", url: png }],
        }}
        onSubmit={() => {}}
      />
    ),
    host,
  )
  cleanup = () => {
    dispose()
    host.remove()
  }
  return host
}

test("permission level follows the attachment button and defaults to Ask", () => {
  const host = renderImageDraft("/session-mode-layout")
  const buttons = [...host.querySelector(".composer-bar")!.querySelectorAll("button")]
  expect(buttons[0]?.getAttribute("aria-label")).toBe("附件")
  expect(buttons[1]?.getAttribute("aria-label")).toContain("询问")
})

test("the composer exposes the requested permission labels and safety descriptions", () => {
  const levels = modeOptions()
  expect(levels.map((option) => option.value)).toEqual(["ask", "autoApprove", "fullTakeover"])
  const takeover = levels.find((option) => option.value === "fullTakeover")!
  expect(takeover.tone).toBe("danger")
  expect(takeover.badge).toBe("危险")
  expect(levels.map(({ label, description }) => ({ label, description }))).toEqual([
    { label: "每次询问", description: "智能体全量操作询问用户，安全性最高" },
    {
      label: "仅询问危险行为",
      description: "沙箱已启动时，工作区内普通操作直接运行；推送、提权、越界和离开沙箱仍询问，安全性中等",
    },
    { label: "全面接管", description: "将控制权完全交给 MerakCode，所有操作均允许，安全性最低" },
  ])
})

test("English permission choices explain the same safety levels", () => {
  setLocale("en")
  expect(modeOptions().map(({ label, description }) => ({ label, description }))).toEqual([
    { label: "Ask every time", description: "Ask the user about every agent operation. Highest safety." },
    {
      label: "Ask only for risky actions",
      description:
        "With the sandbox on, ordinary workspace actions run without asking. Push, privilege, leaving the sandbox and other escalations still ask. Medium safety.",
    },
    { label: "Full takeover", description: "Give MerakCode full control and allow all operations. Lowest safety." },
  ])
})

test("a disabled composer keeps its draft and prevents typing or sending", () => {
  const host = document.createElement("div")
  document.body.appendChild(host)
  const [disabled, setDisabled] = createSignal(false)
  const submissions: unknown[] = []
  const dispose = render(
    () => (
      <Composer
        directory="/composer-lock-test"
        busy={false}
        disabled={disabled()}
        draft={{ text: "Keep this draft", files: [] }}
        onSubmit={(submission) => void submissions.push(submission)}
      />
    ),
    host,
  )
  cleanup = () => {
    dispose()
    host.remove()
  }
  const input = host.querySelector("textarea")!
  setDisabled(true)
  expect(input.disabled).toBe(true)
  expect(input.value).toBe("Keep this draft")
  input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }))
  expect(submissions).toEqual([])
  expect(host.querySelector<HTMLButtonElement>('[aria-label="附件"]')?.disabled).toBe(true)
  setDisabled(false)
  expect(input.disabled).toBe(false)
  expect(input.value).toBe("Keep this draft")
})

test("a composer discards an attachment from before a lock even after input is enabled again", () => {
  let finish: (() => void) | undefined
  vi.stubGlobal(
    "FileReader",
    class {
      result = "data:text/plain;base64,c2VjcmV0"
      onload?: () => void
      readAsDataURL() {
        finish = () => this.onload?.()
      }
    },
  )
  const host = document.createElement("div")
  document.body.appendChild(host)
  const [disabled, setDisabled] = createSignal(false)
  const dispose = render(
    () => <Composer directory="/composer-drop-test" busy={false} disabled={disabled()} onSubmit={() => {}} />,
    host,
  )
  cleanup = () => {
    dispose()
    host.remove()
  }
  const event = new Event("drop", { bubbles: true, cancelable: true })
  Object.defineProperty(event, "dataTransfer", { value: { files: [new File(["secret"], "blocked.txt")] } })
  host.querySelector(".composer")!.dispatchEvent(event)
  expect(finish).toBeTypeOf("function")
  setDisabled(true)
  setDisabled(false)
  finish!()
  expect(host.textContent).not.toContain("blocked.txt")
})

test("an external text composer does not require a native model or offer attachments", () => {
  const host = document.createElement("div")
  document.body.appendChild(host)
  const dispose = render(
    () => <Composer directory="/external-composer-test" busy={false} external onSubmit={() => {}} />,
    host,
  )
  cleanup = () => {
    dispose()
    host.remove()
  }
  expect(host.textContent).not.toContain("还没有连接模型")
  expect(host.querySelector('[aria-label="附件"]')).toBeNull()
})

test("an image draft shows a thumbnail in the composer", () => {
  const host = renderImageDraft("/composer-image-test")
  expect(host.querySelector(".composer-files img")?.getAttribute("src")).toBe(png)
  expect(host.querySelector(".composer-files")?.textContent).toContain("shot.png")
  expect(host.querySelector('[aria-label="查看图片 shot.png"]')).not.toBeNull()
})

test("clicking an image attachment's name opens the full image", async () => {
  const host = renderImageDraft("/composer-image-name-test")
  const name = [...host.querySelectorAll(".composer-files .ellipsis")].find((node) => node.textContent === "shot.png")
  if (!name) throw new Error("attachment name did not render")
  name.dispatchEvent(new MouseEvent("click", { bubbles: true }))
  await vi.waitFor(() => expect(document.querySelector("[role=dialog] img")?.getAttribute("src")).toBe(png))
  document.querySelector<HTMLButtonElement>("[role=dialog] .dialog-foot button")!.click()
  await vi.waitFor(() => expect(document.querySelector("[role=dialog]")).toBeNull())
})

test("removing an image attachment does not open its preview", () => {
  const host = renderImageDraft("/composer-image-remove-test")
  host.querySelector<HTMLButtonElement>('[aria-label="移除 shot.png"]')!.click()
  expect(host.querySelector(".composer-files .attachment")).toBeNull()
  expect(document.querySelector("[role=dialog]")).toBeNull()
})

test.each([
  ["attachment", "zh", "MRK-4008"],
  ["attachment", "en", "MRK-4008"],
  ["disabled", "zh", "MRK-4006"],
  ["disabled", "en", "MRK-4006"],
  ["imported", "zh", "MRK-4008"],
  ["imported", "en", "MRK-4008"],
] as const)(
  "an external %s rejection in %s shows its error code and preserves the draft",
  async (reason, locale, code) => {
    setLocale(locale)
    const sessionID = `external-${reason}-error-${locale}`
    const directory = "/external-attachment-error"
    setState("sessions", "session", [
      {
        id: sessionID,
        slug: sessionID,
        projectID: "global",
        directory,
        title: "External attachment",
        version: "1",
        time: { created: 1, updated: 1 },
        target: { kind: "external", productID: "claude" },
        ...(reason === "disabled"
          ? {
              targetBlock: {
                blockID: "disabled-block",
                productID: "claude",
                disabledCycleID: "disabled-cycle",
                decision: "declined" as const,
              },
            }
          : {}),
        ...(reason === "imported" ? { readOnlyReason: "imported-external-history" as const } : {}),
      },
    ])
    const host = document.createElement("div")
    document.body.appendChild(host)
    const dispose = render(
      () => (
        <>
          <Composer
            sessionID={sessionID}
            directory={directory}
            busy={false}
            external
            draft={{
              text: "Keep this draft",
              files: [{ type: "file", mime: "text/plain", filename: "draft.txt", url: "file:///project/draft.txt" }],
            }}
            onSubmit={(submission) => send(sessionID, directory, submission)}
          />
          <Toasts />
        </>
      ),
      host,
    )
    cleanup = () => {
      host.querySelectorAll<HTMLButtonElement>(".toast > button:last-child").forEach((button) => button.click())
      dispose()
      host.remove()
    }
    host.querySelector("textarea")!.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }))
    await vi.waitFor(() => expect(host.querySelector(".toasts")?.textContent).toContain(code))
    const copyLabel =
      locale === "zh" ? "复制详情（反馈问题时附上）" : "Copy details (attach them when reporting a problem)"
    expect(host.querySelector<HTMLButtonElement>(`.toasts [aria-label="${copyLabel}"]`)).not.toBeNull()
    expect(host.querySelector("textarea")!.value).toBe("Keep this draft")
    expect(host.querySelector(".composer-files")?.textContent).toContain("draft.txt")
  },
)
