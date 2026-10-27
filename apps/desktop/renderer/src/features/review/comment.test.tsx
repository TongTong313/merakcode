import path from "node:path"
import { createServer, request, type Server } from "node:http"
import { startEngine, type Engine } from "@merakcode/sdk/process"
import { readFile, writeFile } from "node:fs/promises"
import { createMerakCode, type MerakCode, type MerakCodeSession } from "@merakcode/sdk"
import { afterAll, afterEach, beforeAll, beforeEach, expect, test, vi } from "vitest"
import { render } from "solid-js/web"
import { engine, sandbox, type Sandbox } from "../../../../../../packages/sdk/js/test/fixture/engine"
import { fakeModel, type Reply, type Turn } from "../../../../../../packages/sdk/js/test/fixture/model"
import { setLocale, t } from "../../i18n"
import { ensureSession, reload, refreshVcs, openFolder } from "../../state/store"
import { ReviewPanel } from "./review"
import { ReviewFull } from "./full"
import { SourceControl } from "../git/source-control"
import { clearComments, openReview, setReview, useReview } from "./state"

let env: Sandbox
let merak: MerakCode
let backend: Engine
let proxy: Server
let session: MerakCodeSession
let model: Awaited<ReturnType<typeof fakeModel>>
let script: (turn: Turn) => Reply = () => ({ text: "Done" })
const traffic: string[] = []
let reviewGate: Promise<void> | undefined
let releaseReview = () => {}
let promptGate: Promise<void> | undefined
let releasePrompt = () => {}
let host: HTMLDivElement
let dispose = () => {}
let loadError = () => ""
const original = "a\nb\n"
const edited = "a\ntwo\nb\n"
const file = "math.txt"
const eventually: typeof expect.poll = (check, options) => expect.poll(check, { timeout: 10_000, ...options })

beforeAll(async () => {
  vi.stubGlobal("requestIdleCallback", (callback: IdleRequestCallback) =>
    window.setTimeout(() => callback({ didTimeout: false, timeRemaining: () => 50 }), 0),
  )
  model = await fakeModel((turn) => script(turn))
  env = await sandbox(model.url)
  backend = await startEngine({ cwd: env.project, executablePath: engine, env: env.env })
  merak = await createMerakCode({ cwd: env.project, url: backend.url, headers: backend.headers })
  // The desktop host authenticates renderer traffic; this real HTTP proxy supplies the same transport boundary.
  proxy = createServer(async (incoming, outgoing) => {
    traffic.push(incoming.url ?? "")
    if (incoming.url?.startsWith("/review?") && reviewGate) await reviewGate
    if (incoming.url?.includes("/prompt_async") && promptGate) await promptGate
    const target = request(
      new URL(incoming.url ?? "/", backend.url),
      {
        method: incoming.method,
        headers: { ...incoming.headers, ...backend.headers },
      },
      (response) => {
        outgoing.writeHead(response.statusCode ?? 500, response.headers)
        response.pipe(outgoing)
      },
    )
    target.on("error", (error) => outgoing.destroy(error))
    incoming.pipe(target)
  })
  await new Promise<void>((resolve) => proxy.listen(0, "127.0.0.1", resolve))
  const address = proxy.address()
  if (!address || typeof address === "string") throw new Error("Renderer transport did not listen")
  location.href = `http://127.0.0.1:${address.port}`
  setLocale("zh")
}, 120_000)

afterAll(async () => {
  await merak?.close()
  if (proxy) await new Promise<void>((resolve) => proxy.close(() => resolve()))
  await backend?.close()
  await model?.close()
  await env?.[Symbol.asyncDispose]()
  vi.unstubAllGlobals()
})

async function edit(content: string, name = file) {
  const steps: Reply[] = [
    { tool: "read", args: { filePath: path.join(env.project, name) } },
    { tool: "write", args: { filePath: path.join(env.project, name), content } },
    { text: "Done" },
  ]
  script = (turn) => steps[turn.results.length]!
  for await (const event of session.run("Update the file", { mode: "auto" }))
    if (event.type === "error") throw event.error
  await ensureSession(session.id, env.project)
  await reload(session.id)
}

beforeEach(async () => {
  setReview({ scope: "session", commenting: undefined, selecting: undefined, messageID: undefined })
  await writeFile(path.join(env.project, file), original)
  session = await merak.session()
  await edit(edited)
  await refreshVcs(env.project)
})

afterEach(() => {
  releaseReview()
  reviewGate = undefined
  releasePrompt()
  promptGate = undefined
  window.getSelection()?.removeAllRanges()
  host?.querySelectorAll<HTMLButtonElement>("[data-discard-draft]").forEach((button) => button.click())
  dispose()
  host?.remove()
  clearComments(session.id)
  setReview({ commenting: undefined, selecting: undefined, messageID: undefined })
})

async function mount(style: "unified" | "split" = "unified", directory = env.project) {
  dispose()
  host?.remove()
  host = document.createElement("div")
  document.body.append(host)
  dispose = render(() => {
    if (style === "split") return <ReviewFull sessionID={session.id} directory={directory} />
    const data = useReview(
      () => session.id,
      () => directory,
    )
    loadError = () => data.error()?.message ?? ""
    return <ReviewPanel sessionID={session.id} directory={directory} data={data} />
  }, host)
  await eventually(() => host.querySelectorAll(".line-comment-add").length, { timeout: 5000 })
    .toBeGreaterThan(0)
    .catch((error: Error) => {
      throw new Error(`${host.textContent}\n${loadError()}\n${JSON.stringify(traffic)}`, { cause: error })
    })
  return host
}

const button = (label: string) =>
  [...host.querySelectorAll<HTMLButtonElement>("button")].find((item) => item.textContent?.trim() === label)!
const box = () => host.querySelector<HTMLTextAreaElement>("textarea")!
const input = (text: string) => {
  box().value = text
  box().dispatchEvent(new InputEvent("input", { bubbles: true }))
}
const save = () => box().dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", ctrlKey: true, bubbles: true }))
async function comment(index = 1, name = file) {
  await eventually(
    () => !!host.querySelector(`[data-file="${name}"] [data-line-index="${index}"] .line-comment-add`),
  ).toBe(true)
  host.querySelector<HTMLButtonElement>(`[data-file="${name}"] [data-line-index="${index}"] .line-comment-add`)!.click()
  await eventually(() => !!box()).toBe(true)
}

test("line feedback is added through the real SDK-backed review", async () => {
  await mount()
  await comment()
  input("Use 2 here")
  save()
  expect(host.querySelector(".line-comment")?.textContent).toContain("Use 2 here")
  expect(host.querySelector(".comment-excerpt")?.textContent).toBe("+two")
  expect(await readFile(path.join(env.project, file), "utf8")).toBe(edited)
})

test("relocating feedback onto another draft preserves both texts", async () => {
  await writeFile(path.join(env.project, "other.txt"), original)
  await edit(edited, "other.txt")
  await mount()
  await comment(1, "other.txt")
  input("Independent draft B")
  box().dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }))
  await comment()
  input("Feedback A to relocate")
  await writeFile(path.join(env.project, file), "a\nreplacement\nb\n")
  await mount()
  await eventually(() => host.textContent).toContain(t("review.draftStale"))
  await comment(1, "other.txt")
  expect(box().value).toBe("Feedback A to relocate")
  expect(host.querySelector(".review-draft")?.textContent).toContain("Independent draft B")
  save()
  expect(host.querySelector('[data-file="other.txt"] .line-comment')?.textContent).toContain("Feedback A to relocate")
  host.querySelector<HTMLButtonElement>(`button[aria-label="${t("review.resumeDraft")}"]`)!.click()
  await eventually(() => box()?.value).toBe("Independent draft B")
})

test("feedback can be relocated after its entire file leaves pending review", async () => {
  await writeFile(path.join(env.project, "other.txt"), original)
  await edit(edited, "other.txt")
  await mount()
  await comment()
  input("Keep feedback after accepting its file")
  const accept = [...host.querySelectorAll<HTMLButtonElement>(`[data-file="${file}"] button`)].find(
    (item) => item.textContent?.trim() === t("review.acceptFile"),
  )!
  await eventually(() => accept.disabled).toBe(false)
  accept.click()
  await eventually(() => host.querySelector(`[data-file="${file}"]`)).toBeNull()
  expect(box().value).toBe("Keep feedback after accepting its file")
  await comment(1, "other.txt")
  expect(box().value).toBe("Keep feedback after accepting its file")
  save()
  expect(host.querySelector('[data-file="other.txt"] .line-comment')?.textContent).toContain(
    "Keep feedback after accepting its file",
  )
})

test("deleted-line feedback still reveals its line after split review returns to unified", async () => {
  await edit("a\n")
  await mount("split")
  await eventually(() => !!host.querySelector('[data-side="old"].del .line-comment-add')).toBe(true)
  host.querySelector<HTMLButtonElement>('[data-side="old"].del .line-comment-add')!.click()
  await eventually(() => !!box()).toBe(true)
  input("Keep this deleted line")
  save()
  expect(host.querySelector(".comment-excerpt")?.textContent).toBe("-b")
  await mount()
  host.querySelector<HTMLButtonElement>(".line-comment .comment-location")!.click()
  await eventually(() => host.querySelector('.line.del[data-side="unified"]')?.classList.contains("flash")).toBe(true)
})

test("refreshing and remounting the real review retains an active draft", async () => {
  await mount()
  await comment()
  input("Preserve feedback during refresh")
  await mount()
  await eventually(() => box()?.value).toBe("Preserve feedback during refresh")
  expect(button(t("common.add")).disabled).toBe(false)
})

test("native multi-line selection stores the exact selected excerpt", async () => {
  await mount()
  const first = host.querySelector('[data-line-index="1"] .code')!
  const last = host.querySelector('[data-line-index="2"] .code')!
  const range = document.createRange()
  range.setStart(first.firstChild!, 0)
  range.setEnd(last.firstChild!, 1)
  window.getSelection()!.removeAllRanges()
  window.getSelection()!.addRange(range)
  last.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }))
  expect(box()).toBeNull()
  button(t("review.selectionComment")).click()
  await eventually(() => !!box()).toBe(true)
  input("Only these selected lines")
  save()
  expect(host.querySelector(".comment-excerpt")?.textContent).toBe("+two\n b")
  expect(host.querySelector(".line-comment .comment-location")?.textContent).toBe(`${file}:2–3`)
  window.getSelection()!.removeAllRanges()
})

test("a selection ending at the next line's start excludes that line in either direction", async () => {
  await mount()
  for (const backwards of [false, true]) {
    const first = host.querySelector('[data-line-index="1"] .code')!
    const last = host.querySelector('[data-line-index="2"] .code')!
    const selection = window.getSelection()!
    selection.setBaseAndExtent((backwards ? last : first).firstChild!, 0, (backwards ? first : last).firstChild!, 0)
    expect(selection.toString()).not.toContain("b")
    last.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }))
    button(t("review.selectionComment")).click()
    await eventually(() => !!box()).toBe(true)
    input("Only the selected line")
    save()
    expect(host.querySelector(".comment-excerpt")?.textContent).toBe("+two")
    expect(host.querySelector(".line-comment .comment-location")?.textContent).toBe(`${file}:2`)
    host.querySelector<HTMLButtonElement>(`.line-comment button[aria-label="${t("common.remove")}"]`)!.click()
    selection.removeAllRanges()
  }
})

test("closing the editor leaves a draft that can be resumed after remount", async () => {
  await mount()
  await comment()
  input("Resume this feedback")
  box().dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }))
  await mount()
  expect(box()).toBeNull()
  host.querySelector<HTMLButtonElement>(`button[aria-label="${t("review.resumeDraft")}"]`)!.click()
  await eventually(() => box()?.value).toBe("Resume this feedback")
})

test("review writes remain disabled while the real list request is outstanding", async () => {
  await mount()
  reviewGate = new Promise<void>((resolve) => {
    releaseReview = resolve
  })
  await mount()
  expect(button(t("review.rejectFile")).disabled).toBe(true)
  releaseReview()
  reviewGate = undefined
  await eventually(() => button(t("review.rejectFile")).disabled).toBe(false)
})

test("replacing selected code preserves feedback until the user relocates it", async () => {
  await mount()
  await comment()
  input("Keep feedback for replaced code")
  await writeFile(path.join(env.project, file), "a\nreplacement\nb\n")
  await mount()
  await eventually(() => host.textContent).toContain(t("review.draftStale"))
  expect(box().value).toBe("Keep feedback for replaced code")
  expect(button(t("common.add")).disabled).toBe(true)
  await comment()
  expect(box().value).toBe("Keep feedback for replaced code")
  expect(button(t("common.add")).disabled).toBe(false)
  save()
  expect(host.querySelector(".comment-excerpt")?.textContent).toBe("+replacement")
})

test("identical code in another turn does not inherit the earlier turn's active draft", async () => {
  await edit("a\nintermediate\nb\n")
  await edit(edited)
  const users = (await session.messages()).filter((message) => message.info.role === "user")
  openReview({ scope: "turn", messageID: users[0]!.info.id })
  await mount()
  await comment()
  input("Feedback for the earlier turn")
  openReview({ scope: "turn", messageID: users.at(-1)!.info.id })
  await eventually(() => box()).toBeNull()
  expect(host.querySelectorAll(".selected-code")).toHaveLength(0)
  expect(host.querySelector(".review-draft")?.textContent).toContain("Feedback for the earlier turn")
  openReview({ scope: "turn", messageID: users[0]!.info.id })
  await eventually(() => box()?.value).toBe("Feedback for the earlier turn")
})

test("directory spelling changes preserve an active draft and its saved feedback", async () => {
  await mount("unified", `${env.project.replaceAll("\\", "/")}/`)
  await comment()
  input("Feedback survives directory spelling changes")
  await mount()
  await eventually(() => box()?.value).toBe("Feedback survives directory spelling changes")
  save()
  expect(host.querySelector(".line-comment")?.textContent).toContain("Feedback survives directory spelling changes")
})

test("mixed selection reports independently correct old and new coordinates", async () => {
  await writeFile(path.join(env.project, file), "a\nremoved\nb\n")
  session = await merak.session()
  await edit(`${Array.from({ length: 18 }, (_, index) => `intro ${index + 1}\n`).join("")}a\nreplacement\nb\n`)
  await mount()
  const first = host.querySelector(".line.del .code")!
  const last = [...host.querySelectorAll(".line.add .code")].find((element) => element.textContent === "replacement")!
  const range = document.createRange()
  range.setStart(first.firstChild!, 0)
  range.setEnd(last.firstChild!, last.textContent!.length)
  window.getSelection()!.removeAllRanges()
  window.getSelection()!.addRange(range)
  last.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }))
  button(t("review.selectionComment")).click()
  await eventually(() => !!box()).toBe(true)
  expect(host.querySelector(".comment-compose .loc")?.textContent).toBe(
    `${file}:${t("review.oldSide")} 2 / ${t("review.newSide")} 20`,
  )
  input("Verify both sides")
  save()
  expect(host.querySelector(".comment-excerpt")?.textContent).toBe("-removed\n+replacement")
  window.getSelection()!.removeAllRanges()
})

test("saved feedback survives an external branch change and can be relocated", async () => {
  for (const args of [
    ["config", "user.name", "Feedback Test"],
    ["config", "user.email", "feedback@example.test"],
    ["add", file],
    ["commit", "-m", "feedback baseline"],
  ])
    expect((await merak.client.vcs.run({ args }, { throwOnError: true })).data.exitCode).toBe(0)
  await refreshVcs(env.project)
  await mount()
  await comment()
  input("Saved feedback across branches")
  save()
  const result = await merak.client.vcs.run(
    { args: ["switch", "-c", `feedback-${crypto.randomUUID()}`] },
    { throwOnError: true },
  )
  expect(result.data.exitCode).toBe(0)
  await eventually(
    async () => {
      await refreshVcs(env.project)
      return host.textContent
    },
    { timeout: 5000 },
  ).toContain(t("review.draftStale"))
  host.querySelector<HTMLButtonElement>(`.pending-comments button[aria-label="${t("review.editComment")}"]`)!.click()
  await eventually(() => box()?.value).toBe("Saved feedback across branches")
  expect(button(t("common.add")).disabled).toBe(true)
  await comment()
  expect(box().value).toBe("Saved feedback across branches")
  save()
  expect(host.querySelectorAll(".line-comment")).toHaveLength(1)
  expect(host.querySelector(".line-comment")?.textContent).toContain("Saved feedback across branches")
})

test("editing saved feedback preserves an independent draft on the same code", async () => {
  await mount()
  await comment()
  input("Saved feedback A")
  save()
  await comment()
  input("Independent draft B")
  box().dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }))
  host.querySelector<HTMLButtonElement>(`.pending-comments button[aria-label="${t("review.editComment")}"]`)!.click()
  await eventually(() => box()?.value).toBe("Saved feedback A")
  input("Updated feedback A")
  save()
  expect(host.querySelector(".line-comment")?.textContent).toContain("Updated feedback A")
  host.querySelector<HTMLButtonElement>(`button[aria-label="${t("review.resumeDraft")}"]`)!.click()
  await eventually(() => box()?.value).toBe("Independent draft B")
})

test("the Git page fetches pending navigation without requesting review file details", async () => {
  await writeFile(path.join(env.project, file), `${edited}manual delta\n`)
  await openFolder(env.project)
  traffic.length = 0
  host = document.createElement("div")
  document.body.append(host)
  dispose = render(() => <SourceControl sessionID={session.id} directory={env.project} folder={env.project} />, host)
  await eventually(() => !!host.querySelector(`button[aria-label="${t("git.reviewFile", { file })}"]`)).toBe(true)
  await new Promise<void>((resolve) => requestIdleCallback(() => resolve()))
  await new Promise((resolve) => setTimeout(resolve, 200))
  const detailRequests = traffic.filter((value) => {
    const url = new URL(value, merak.url)
    return url.pathname === "/review/file" && url.searchParams.get("sessionID") === session.id
  })
  expect(detailRequests).toEqual([])
})

test("editing relocated feedback does not consume a newer draft at its old location", async () => {
  await writeFile(path.join(env.project, "other.txt"), original)
  await edit(edited, "other.txt")
  await mount()
  await comment()
  input("Saved relocated feedback")
  const accept = [...host.querySelectorAll<HTMLButtonElement>(`[data-file="${file}"] button`)].find(
    (item) => item.textContent?.trim() === t("review.acceptFile"),
  )!
  await eventually(() => accept.disabled).toBe(false)
  accept.click()
  await eventually(() => host.querySelector(`[data-file="${file}"]`)).toBeNull()
  await comment(1, "other.txt")
  save()
  await eventually(() => button(t("review.undo")).disabled, { timeout: 5000 }).toBe(false)
  button(t("review.undo")).click()
  await comment()
  input("A newer independent source draft")
  box().dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }))
  host
    .querySelector<HTMLButtonElement>(`[data-file="other.txt"] button[aria-label="${t("review.editComment")}"]`)!
    .click()
  await eventually(() => box()?.value).toBe("Saved relocated feedback")
  expect(host.querySelector(".review-draft")?.textContent).toContain("A newer independent source draft")
})

test("resuming a relocated draft does not delete a new draft at its source", async () => {
  await writeFile(path.join(env.project, "other.txt"), original)
  await edit(edited, "other.txt")
  await mount()
  await comment()
  input("Relocated draft B")
  const accept = [...host.querySelectorAll<HTMLButtonElement>(`[data-file="${file}"] button`)].find(
    (item) => item.textContent?.trim() === t("review.acceptFile"),
  )!
  await eventually(() => accept.disabled).toBe(false)
  accept.click()
  await eventually(() => host.querySelector(`[data-file="${file}"]`)).toBeNull()
  await comment(1, "other.txt")
  box().dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }))
  await eventually(() => button(t("review.undo")).disabled, { timeout: 5000 }).toBe(false)
  button(t("review.undo")).click()
  await comment()
  input("New source draft C")
  box().dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }))
  const relocated = [...host.querySelectorAll(".review-draft")].find((element) =>
    element.textContent?.includes("Relocated draft B"),
  )!
  relocated.querySelector<HTMLButtonElement>("button")!.click()
  await eventually(() => box()?.value).toBe("Relocated draft B")
  expect(host.querySelector(".review-draft")?.textContent).toContain("New source draft C")
})

test("feedback relocated during submission stays pending when the earlier send succeeds", async () => {
  await writeFile(path.join(env.project, "other.txt"), original)
  await edit(edited, "other.txt")
  await mount()
  await comment()
  input("Feedback moves to the other file")
  save()
  script = () => ({ text: "Feedback received" })
  promptGate = new Promise<void>((resolve) => {
    releasePrompt = resolve
  })
  const requests = () => traffic.filter((url) => url.includes("/prompt_async")).length
  const before = requests()
  button(t("review.send")).click()
  await eventually(requests).toBeGreaterThan(before)
  const accept = [...host.querySelectorAll<HTMLButtonElement>(`[data-file="${file}"] button`)].find(
    (item) => item.textContent?.trim() === t("review.acceptFile"),
  )!
  await eventually(() => accept.disabled).toBe(false)
  accept.click()
  await eventually(() => host.querySelector(`[data-file="${file}"]`)).toBeNull()
  host.querySelector<HTMLButtonElement>(`.pending-comments button[aria-label="${t("review.editComment")}"]`)!.click()
  await eventually(() => box()?.value).toBe("Feedback moves to the other file")
  await comment(1, "other.txt")
  save()
  const feedback = () => host.querySelector('[data-file="other.txt"] .line-comment')?.textContent ?? ""
  await eventually(feedback).toContain("Feedback moves to the other file")
  releasePrompt()
  await eventually(() => button(t("review.send"))?.disabled).not.toBe(true)
  expect(feedback()).toContain("Feedback moves to the other file")
  expect(host.querySelector(".pending-comments")?.textContent).toContain(t("review.pending", { count: 1 }))
})
