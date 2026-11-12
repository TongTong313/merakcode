import path from "node:path"
import { readFile, writeFile } from "node:fs/promises"
import { afterAll, afterEach, beforeAll, beforeEach, expect, test, vi } from "vitest"
import { render } from "solid-js/web"
import { engineFixture } from "../../test/engine"
import { client } from "../../state/client"
import { setLocale, t } from "../../i18n"
import { ensureSession, setState } from "../../state/store"
import { refreshBranches } from "../../state/git"
import { ReviewPanel } from "./review"
import { ReviewFull } from "./full"
import { SourceControl } from "../git/source-control"
import { clearComments, commentsOf, review, setReview, useReview } from "./state"

let env: Awaited<ReturnType<typeof engineFixture>>
let session: { id: string }
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
  env = await engineFixture()
  location.href = env.url
  setLocale("zh")
}, 120_000)

afterAll(async () => {
  try {
    await (await client()).close()
  } finally {
    await env?.close()
    vi.unstubAllGlobals()
  }
})

async function newSession() {
  const connection = await client()
  const created = await connection.session.create({ provider: "fake", model: "test", workdir: env.project })
  setState("sessions", (await connection.session.list()) ?? [])
  await ensureSession(created.session)
  return { id: created.session }
}
async function edit(content: string, name = file) {
  await writeFile(path.join(env.project, name), content)
}
beforeEach(async () => {
  setReview({ scope: "session", comments: {}, commenting: undefined, selecting: undefined, messageID: undefined })
  await writeFile(path.join(env.project, file), original)
  await writeFile(path.join(env.project, "other.txt"), original)
  await env.git("add", ".")
  await env.git("commit", "--allow-empty", "-m", "Review fixture")
  session = await newSession()
  await edit(edited)
  await refreshBranches(env.project)
})
afterEach(() => {
  window.getSelection()?.removeAllRanges()
  host?.querySelectorAll<HTMLButtonElement>("[data-discard-draft]").forEach((button) => button.click())
  dispose()
  host?.remove()
  if (session) clearComments(session.id)
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
      throw new Error(`${host.textContent}\n${loadError()}`, { cause: error })
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
  await writeFile(path.join(env.project, file), original)
  await mount()
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

test("review offers to comment on lines and to accept or reject files", async () => {
  await mount()
  expect(button(t("review.acceptFile"))).toBeDefined()
  expect(button(t("review.rejectFile"))).toBeDefined()
  expect(host.querySelectorAll(".line-comment-add").length).toBeGreaterThan(0)
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

test("another conversation does not inherit the first conversation's active draft", async () => {
  await mount()
  await comment()
  input("Feedback for the first conversation")
  const first = session
  session = await newSession()
  await mount()
  expect(box()).toBeNull()
  session = first
  await mount()
  await eventually(() => box()?.value).toBe("Feedback for the first conversation")
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
  await env.git("add", file)
  await env.git("commit", "-m", "Coordinate fixture")
  session = await newSession()
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
    await env.git(...args)
  await refreshBranches(env.project)
  await mount()
  await comment()
  input("Saved feedback across branches")
  save()
  await env.git("switch", "-c", `feedback-${crypto.randomUUID()}`)
  await eventually(
    async () => {
      await refreshBranches(env.project)
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

test("the Git page displays changed files and navigates to review", async () => {
  await writeFile(path.join(env.project, file), `${edited}manual delta\n`)
  host = document.createElement("div")
  document.body.append(host)
  dispose = render(() => <SourceControl sessionID={session.id} directory={env.project} folder={env.project} />, host)
  await eventually(() => !!host.querySelector(`button[aria-label="${t("git.reviewFile", { file })}"]`)).toBe(true)
  host.querySelector<HTMLButtonElement>(`button[aria-label="${t("git.reviewFile", { file })}"]`)!.click()
  expect(review.focus).toBe(file)
})

test("editing relocated feedback does not consume a newer draft at its old location", async () => {
  await writeFile(path.join(env.project, "other.txt"), original)
  await edit(edited, "other.txt")
  await mount()
  await comment()
  input("Saved relocated feedback")
  await writeFile(path.join(env.project, file), original)
  await mount()
  await eventually(() => host.querySelector(`[data-file="${file}"]`)).toBeNull()
  await comment(1, "other.txt")
  save()
  await writeFile(path.join(env.project, file), edited)
  await mount()
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
  await writeFile(path.join(env.project, file), original)
  await mount()
  await eventually(() => host.querySelector(`[data-file="${file}"]`)).toBeNull()
  await comment(1, "other.txt")
  box().dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }))
  await writeFile(path.join(env.project, file), edited)
  await mount()
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

test("clearing submitted feedback preserves a newer edit", async () => {
  await mount()
  await comment()
  input("First feedback")
  save()
  const submitted = commentsOf(session.id).map((comment) => ({
    ...comment,
    rows: comment.rows.map((row) => ({ ...row })),
  }))
  host.querySelector<HTMLButtonElement>(`.pending-comments button[aria-label="${t("review.editComment")}"]`)!.click()
  await eventually(() => box()?.value).toBe("First feedback")
  input("Newer feedback")
  save()
  clearComments(session.id, submitted, env.project)
  expect(host.querySelector(".line-comment")?.textContent).toContain("Newer feedback")
})
