import { afterAll, beforeEach, describe, expect, test, vi } from "vitest"
import fs from "fs"
import os from "os"
import path from "path"
import { Provider } from "@merakcode/engine/agent/model/provider"
import { ProviderTransform } from "@merakcode/engine/agent/model/transform"
import { Instance } from "@merakcode/engine/infra/project/instance"
import { Log } from "@merakcode/log/logger"
import { Process } from "@merakcode/util/process"

Log.init({ print: false })

let lastGenerateTextInput: { system?: string; prompt?: string } = {}

const fakeModel = { providerID: "test", id: "small", api: { id: "small" } }

// Override only the Provider / Transform methods this test needs. Mocking the whole module would drop exports such
// as invalidateAll and leak into later test files.
const originalProvider = {
  defaultModel: Provider.defaultModel,
  getSmallModel: Provider.getSmallModel,
  getModel: Provider.getModel,
  getLanguage: Provider.getLanguage,
}
const originalTransform = {
  providerOptions: ProviderTransform.providerOptions,
  completionOptions: ProviderTransform.completionOptions,
}

Provider.defaultModel = (async () => ({
  providerID: "test",
  modelID: "small",
})) as unknown as typeof Provider.defaultModel
Provider.getSmallModel = (async () => fakeModel) as unknown as typeof Provider.getSmallModel
Provider.getModel = (async () => fakeModel) as unknown as typeof Provider.getModel
Provider.getLanguage = (async () => "mock-language-model") as unknown as typeof Provider.getLanguage
ProviderTransform.providerOptions = (() => ({})) as unknown as typeof ProviderTransform.providerOptions
ProviderTransform.completionOptions = (() => ({})) as unknown as typeof ProviderTransform.completionOptions

// Mock only the external LLM boundary (generateText from the Vercel AI SDK) and keep the other real exports, since
// Provider/transform still use LoadAPIKeyError and others. The fenced reply checks both that the model output
// reaches the endpoint and that fences are stripped.
vi.mock("ai", async (importOriginal) => ({
  ...(await importOriginal<typeof import("ai")>()),
  generateText: async (input: { system?: string; prompt?: string }) => {
    lastGenerateTextInput = input
    return { text: "```\nfeat: 新增自动生成提交信息按钮\n```" }
  },
}))

afterAll(() => {
  Provider.defaultModel = originalProvider.defaultModel
  Provider.getSmallModel = originalProvider.getSmallModel
  Provider.getModel = originalProvider.getModel
  Provider.getLanguage = originalProvider.getLanguage
  ProviderTransform.providerOptions = originalTransform.providerOptions
  ProviderTransform.completionOptions = originalTransform.completionOptions
})

async function makeRepoWithStaged() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mc-commit-gen-"))
  await Process.run(["git", "init", "-q"], { cwd: dir })
  await Process.run(["git", "config", "user.email", "t@t.io"], { cwd: dir })
  await Process.run(["git", "config", "user.name", "t"], { cwd: dir })
  fs.writeFileSync(path.join(dir, "README.md"), "# hello\n")
  await Process.run(["git", "add", "-A"], { cwd: dir })
  await Process.run(["git", "commit", "-q", "-m", "chore: init"], { cwd: dir })
  fs.writeFileSync(path.join(dir, "README.md"), "# hello world\nmore\n")
  await Process.run(["git", "add", "-A"], { cwd: dir })
  return dir
}

async function makeRepoWithManyUntracked(count: number) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mc-commit-untracked-"))
  await Process.run(["git", "init", "-q"], { cwd: dir })
  await Process.run(["git", "config", "user.email", "t@t.io"], { cwd: dir })
  await Process.run(["git", "config", "user.name", "t"], { cwd: dir })
  fs.writeFileSync(path.join(dir, "README.md"), "# hello\n")
  await Process.run(["git", "add", "-A"], { cwd: dir })
  await Process.run(["git", "commit", "-q", "-m", "chore: init"], { cwd: dir })
  for (let i = 0; i < count; i++) fs.writeFileSync(path.join(dir, `file-${i}.html`), `<html>${i}</html>`)
  fs.writeFileSync(path.join(dir, "demo.html"), "<!DOCTYPE html><title>demo</title>")
  return dir
}

async function makeRepoWithLargeUntracked() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mc-commit-large-"))
  await Process.run(["git", "init", "-q"], { cwd: dir })
  await Process.run(["git", "config", "user.email", "t@t.io"], { cwd: dir })
  await Process.run(["git", "config", "user.name", "t"], { cwd: dir })
  fs.writeFileSync(path.join(dir, "README.md"), "# hello\n")
  await Process.run(["git", "add", "-A"], { cwd: dir })
  await Process.run(["git", "commit", "-q", "-m", "chore: init"], { cwd: dir })
  fs.writeFileSync(path.join(dir, "demo.html"), "<!DOCTYPE html><title>demo</title>")
  // A recognizable prefix plus >2KB of content checks that the prefix is read rather than the file dropped.
  fs.writeFileSync(path.join(dir, "big.html"), "<!-- LARGE_PREFIX -->" + "x".repeat(3000))
  return dir
}

/** Creates a repo with only a root commit; callers add their own changes. */
async function initRepo(prefix: string) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  await Process.run(["git", "init", "-q"], { cwd: dir })
  await Process.run(["git", "config", "user.email", "t@t.io"], { cwd: dir })
  await Process.run(["git", "config", "user.name", "t"], { cwd: dir })
  fs.writeFileSync(path.join(dir, "README.md"), "# hello\n")
  await Process.run(["git", "add", "-A"], { cwd: dir })
  await Process.run(["git", "commit", "-q", "-m", "chore: init"], { cwd: dir })
  return dir
}

/** Untracked Chinese and spaced English paths, to check paths and samples reach the prompt unescaped. */
async function makeRepoWithMixedPathUntracked() {
  const dir = await initRepo("mc-commit-paths-")
  fs.writeFileSync(path.join(dir, "测试.md"), "# 中文内容采样标记\n")
  fs.writeFileSync(path.join(dir, "hello world.md"), "# spaced english\n")
  fs.writeFileSync(path.join(dir, "snake-game.html"), "<!DOCTYPE html><title>snake</title>\n")
  return dir
}

async function makeRepoWithStagedChinese() {
  const dir = await initRepo("mc-commit-staged-zh-")
  fs.writeFileSync(path.join(dir, "功能说明.md"), "# staged zh\n")
  await Process.run(["git", "add", "-A"], { cwd: dir })
  return dir
}

async function makeRepoWithWorkingChinese() {
  const dir = await initRepo("mc-commit-working-zh-")
  fs.writeFileSync(path.join(dir, "修订说明.md"), "# v1\n")
  await Process.run(["git", "add", "-A"], { cwd: dir })
  await Process.run(["git", "commit", "-q", "-m", "chore: add zh"], { cwd: dir })
  fs.writeFileSync(path.join(dir, "修订说明.md"), "# v2 working\n")
  return dir
}

const cleanup: string[] = []
afterAll(() => {
  for (const dir of cleanup) fs.rmSync(dir, { recursive: true, force: true })
})

describe("POST /assist/commit-message (happy path, only the external LLM mocked)", () => {
  beforeEach(() => {
    lastGenerateTextInput = {}
  })

  test("returns the cleaned model output for staged changes", async () => {
    const { AssistRoutes } = await import("@merakcode/engine/app/server/routes/assist")
    const dir = await makeRepoWithStaged()
    cleanup.push(dir)

    const res = await Instance.provide({
      directory: dir,
      fn: () => AssistRoutes().request("/commit-message", { method: "POST" }),
    })

    expect(res.status).toBe(200)
    const body = (await res.json()) as { message?: string }
    expect(body.message).toBe("feat: 新增自动生成提交信息按钮")
    expect(lastGenerateTextInput.prompt).toContain("staged")
  })

  test("summarizes and samples many untracked files in the prompt instead of listing every path", async () => {
    const { AssistRoutes } = await import("@merakcode/engine/app/server/routes/assist")
    const dir = await makeRepoWithManyUntracked(50)
    cleanup.push(dir)

    const res = await Instance.provide({
      directory: dir,
      fn: () => AssistRoutes().request("/commit-message", { method: "POST" }),
    })

    expect(res.status).toBe(200)
    const prompt = lastGenerateTextInput.prompt ?? ""
    expect(prompt).toContain("51")
    expect(prompt).toContain("and 31 more")
    expect(prompt).toContain("<!DOCTYPE html>")
    expect((prompt.match(/^\+ /gm) ?? []).length).toBe(20)
    expect(prompt).toContain("+ demo.html")
    expect(prompt).toContain("working")
    expect(lastGenerateTextInput.system).toMatch(/mimic|example/i)
  })

  test("reads the prefix of untracked files over 2KB and marks them truncated", async () => {
    const { AssistRoutes } = await import("@merakcode/engine/app/server/routes/assist")
    const dir = await makeRepoWithLargeUntracked()
    cleanup.push(dir)

    const res = await Instance.provide({
      directory: dir,
      fn: () => AssistRoutes().request("/commit-message", { method: "POST" }),
    })

    expect(res.status).toBe(200)
    const prompt = lastGenerateTextInput.prompt ?? ""
    expect(prompt).toContain("<!DOCTYPE html>")
    expect(prompt).toContain("<!-- LARGE_PREFIX -->")
    expect(prompt).toContain("x".repeat(100))
    expect(prompt).toContain("…(file content truncated)")
    expect(prompt).toContain("+ big.html")
    expect(prompt).not.toContain("x".repeat(2500))
  })

  test("untracked non-ASCII and spaced paths reach the prompt as plain UTF-8, without quotePath escaping", async () => {
    const { AssistRoutes } = await import("@merakcode/engine/app/server/routes/assist")
    const dir = await makeRepoWithMixedPathUntracked()
    cleanup.push(dir)

    const res = await Instance.provide({
      directory: dir,
      fn: () => AssistRoutes().request("/commit-message", { method: "POST" }),
    })

    expect(res.status).toBe(200)
    const prompt = lastGenerateTextInput.prompt ?? ""
    expect(prompt).toContain("+ 测试.md")
    expect(prompt).toContain("+ hello world.md")
    expect(prompt).toContain("+ snake-game.html")
    expect(prompt).toContain("--- 测试.md (snippet) ---")
    expect(prompt).toContain("中文内容采样标记")
    expect(prompt).not.toMatch(/"\\[0-7]{3}/)
  })

  test("staged Chinese paths reach the prompt as plain UTF-8", async () => {
    const { AssistRoutes } = await import("@merakcode/engine/app/server/routes/assist")
    const dir = await makeRepoWithStagedChinese()
    cleanup.push(dir)

    const res = await Instance.provide({
      directory: dir,
      fn: () => AssistRoutes().request("/commit-message", { method: "POST" }),
    })

    expect(res.status).toBe(200)
    const prompt = lastGenerateTextInput.prompt ?? ""
    expect(prompt).toContain("staged")
    expect(prompt).toContain("功能说明.md")
    expect(prompt).not.toMatch(/"\\[0-7]{3}/)
  })

  test("unstaged changes to tracked Chinese paths reach the prompt as plain UTF-8", async () => {
    const { AssistRoutes } = await import("@merakcode/engine/app/server/routes/assist")
    const dir = await makeRepoWithWorkingChinese()
    cleanup.push(dir)

    const res = await Instance.provide({
      directory: dir,
      fn: () => AssistRoutes().request("/commit-message", { method: "POST" }),
    })

    expect(res.status).toBe(200)
    const prompt = lastGenerateTextInput.prompt ?? ""
    expect(prompt).toContain("working")
    expect(prompt).toContain("修订说明.md")
    expect(prompt).not.toMatch(/"\\[0-7]{3}/)
  })
})
