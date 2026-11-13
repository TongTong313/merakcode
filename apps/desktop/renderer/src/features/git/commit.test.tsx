import { execFileSync } from "node:child_process"
import { mkdirSync, writeFileSync } from "node:fs"
import path from "node:path"
import { createRoot, type JSX } from "solid-js"
import { render } from "solid-js/web"
import { afterAll, afterEach, beforeAll, expect, test } from "vitest"
import { setLocale, t } from "../../i18n"
import { engineFixture } from "../../test/engine"
import { client } from "../../state/client"
import { refreshBranches } from "../../state/git"
import { selectPanels } from "../panel/workspace"
import { useGitChanges } from "./changes"
import { Commit } from "./commit"

let env: Awaited<ReturnType<typeof engineFixture>>
beforeAll(async () => {
  env = await engineFixture()
  location.href = env.url
}, 120_000)
afterAll(async () => {
  try {
    await (await client()).close()
  } finally {
    await env?.close()
  }
})

const cleanups: (() => void)[] = []
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup()
})

const git = (directory: string, ...args: string[]) =>
  execFileSync("git", ["-C", directory, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  }).trim()

/** A real repository next to the engine's project, optionally with a bare repository as `origin`. */
function repository(name: string, options: { remote?: "plain" | "pushed" } = {}) {
  const directory = path.join(env.project, "..", name)
  mkdirSync(directory)
  git(directory, "init", "-q", "-b", "main")
  git(directory, "config", "core.autocrlf", "false")
  git(directory, "config", "user.name", "Fixture")
  git(directory, "config", "user.email", "fixture@example.invalid")
  writeFileSync(path.join(directory, "a.txt"), "a\n")
  writeFileSync(path.join(directory, "c.txt"), "c\n")
  git(directory, "add", ".")
  git(directory, "commit", "-q", "-m", "initial")
  const remote = path.join(env.project, "..", `${name}-remote.git`)
  if (options.remote) {
    execFileSync("git", ["init", "--bare", "--quiet", remote], { windowsHide: true })
    git(directory, "remote", "add", "origin", remote)
  }
  if (options.remote === "pushed") git(directory, "push", "-q", "-u", "origin", "main")
  return { directory, remote }
}

/** Mounts the form over the live repository summary, exactly as the Git tab does. */
async function mount(directory: string, props: Partial<Parameters<typeof Commit>[0]> = {}) {
  setLocale("zh")
  await refreshBranches(directory)
  const host = document.createElement("div")
  document.body.append(host)
  let changes!: ReturnType<typeof useGitChanges>
  const dispose = createRoot((dispose) => {
    changes = useGitChanges(() => directory)
    return dispose
  })
  await changes.refresh()
  const draw = render(
    (): JSX.Element => <Commit directory={directory} onDone={() => changes.refresh()} {...props} />,
    host,
  )
  cleanups.push(() => {
    draw()
    dispose()
    host.remove()
  })
  return { host, changes }
}

const button = (host: HTMLElement, label: string) =>
  [...host.querySelectorAll("button")].find((item) => item.textContent?.includes(label))

function type(host: HTMLElement, value: string) {
  const input = host.querySelector<HTMLTextAreaElement>(`textarea[aria-label="${t("review.commitMessage")}"]`)!
  input.value = value
  input.dispatchEvent(new InputEvent("input", { bubbles: true }))
}

test("the branch overview shows ahead, behind and how many files changed", async () => {
  const repo = repository("overview", { remote: "pushed" })
  writeFileSync(path.join(repo.directory, "ahead.txt"), "ahead\n")
  git(repo.directory, "add", "ahead.txt")
  git(repo.directory, "commit", "-q", "-m", "ahead")
  writeFileSync(path.join(repo.directory, "a.txt"), "a changed\n")
  writeFileSync(path.join(repo.directory, "b.txt"), "b\n")
  git(repo.directory, "add", "a.txt", "b.txt")
  writeFileSync(path.join(repo.directory, "c.txt"), "c changed\n")
  writeFileSync(path.join(repo.directory, "d.txt"), "d\n")
  const { host } = await mount(repo.directory)
  const text = host.querySelector(".vcs-summary")?.textContent ?? ""
  expect(text).toContain("main")
  expect(text).toContain(t("review.ahead", { count: 1 }))
  expect(text).toContain(t("review.behind", { count: 0 }))
  expect(text).toContain(t("review.stagedCount", { count: 2 }))
  expect(text).toContain(t("review.unstagedCount", { count: 1 }))
  expect(text).toContain(t("review.untrackedCount", { count: 1 }))
  expect(button(host, t("review.pushCount", { count: 1 }))?.hasAttribute("disabled")).toBe(false)
})

test("commit stays disabled until there is a message and something staged, and then commits the index only", async () => {
  const repo = repository("commit-guard", { remote: "pushed" })
  const { host, changes } = await mount(repo.directory)
  const commit = () => button(host, t("review.commit"))
  expect(commit()?.hasAttribute("disabled")).toBe(true)
  expect(commit()?.parentElement?.getAttribute("title")).toBe(t("review.commitNeedMessage"))
  type(host, "add new")
  expect(commit()?.hasAttribute("disabled")).toBe(true)
  expect(commit()?.parentElement?.getAttribute("title")).toBe(t("review.commitNothing"))
  writeFileSync(path.join(repo.directory, "staged.txt"), "staged\n")
  writeFileSync(path.join(repo.directory, "left.txt"), "left\n")
  await (await client()).repo.stage({ directory: repo.directory, paths: ["staged.txt"] })
  await changes.refresh()
  expect(commit()?.hasAttribute("disabled")).toBe(false)
  const before = git(repo.directory, "rev-parse", "HEAD")
  commit()!.click()
  await expect.poll(() => git(repo.directory, "rev-parse", "HEAD"), { timeout: 15_000 }).not.toBe(before)
  expect(git(repo.directory, "log", "-1", "--format=%s")).toBe("add new")
  expect(git(repo.directory, "show", "--name-only", "--format=", "HEAD")).toBe("staged.txt")
  await expect.poll(() => host.querySelector<HTMLTextAreaElement>("textarea")!.value, { timeout: 15_000 }).toBe("")
  await expect.poll(() => changes.data()?.staged.length, { timeout: 15_000 }).toBe(0)
  expect(changes.data()?.unstaged.map((file) => file.file)).toEqual(["left.txt"])
  expect(git(repo.directory, "status", "--porcelain")).toBe("?? left.txt")
})

test("the first push is enabled when the branch has a remote and no upstream yet, and it publishes the branch", async () => {
  const repo = repository("first-push", { remote: "plain" })
  const { host, changes } = await mount(repo.directory)
  const push = () => button(host, t("review.push"))
  expect(push()?.hasAttribute("disabled")).toBe(false)
  expect(push()?.parentElement?.getAttribute("title")).toBe(t("review.pushUpstream", { remote: "origin" }))
  push()!.click()
  await expect
    .poll(() => git(repo.remote, "rev-parse", "--verify", "refs/heads/main").length, { timeout: 15_000 })
    .toBeGreaterThan(0)
  expect(git(repo.remote, "rev-parse", "main")).toBe(git(repo.directory, "rev-parse", "HEAD"))
  await expect.poll(() => changes.data()?.upstream, { timeout: 15_000 }).toBe(true)
})

test("a branch without a remote cannot push and says why", async () => {
  const repo = repository("no-remote")
  const { host } = await mount(repo.directory)
  const push = button(host, t("review.push"))
  expect(push?.hasAttribute("disabled")).toBe(true)
  expect(push?.parentElement?.getAttribute("title")).toBe(t("review.pushNoRemote"))
})

test("push stays available and is disabled when the branch has nothing to push", async () => {
  const repo = repository("nothing-to-push", { remote: "pushed" })
  writeFileSync(path.join(repo.directory, "a.txt"), "a changed\n")
  git(repo.directory, "add", "a.txt")
  const { host } = await mount(repo.directory)
  const push = button(host, t("review.push"))
  expect(push).toBeTruthy()
  expect(push?.hasAttribute("disabled")).toBe(true)
  expect(push?.parentElement?.getAttribute("title")).toBe(t("review.pushNothing"))
})

test("recovered commit messages can be selected without losing the current draft", async () => {
  const repo = repository("recovered-commits")
  const connection = await client()
  const session = await connection.session.create({ provider: "fake", model: "test", workdir: repo.directory })
  const owner = await selectPanels({ directory: repo.directory, sessionID: session.session })
  const id = owner.open({ kind: "git", view: { commit: "first", commitAlternatives: ["second"] } })
  const host = document.createElement("div")
  document.body.append(host)
  const dispose = render(() => <Commit directory={repo.directory} instanceID={id} onDone={() => {}} />, host)
  cleanups.push(() => {
    dispose()
    host.remove()
  })
  const chooser = host.querySelector("select")!
  expect(chooser).not.toBeNull()
  const input = host.querySelector("textarea")!
  input.value = "first with newer edits"
  input.dispatchEvent(new Event("input", { bubbles: true }))
  chooser.value = "0"
  chooser.dispatchEvent(new Event("change", { bubbles: true }))
  expect(input.value).toBe("second")
  await owner.flush()
  expect(owner.view(id).commitAlternatives).toContain("first with newer edits")
})
