/**
 * Environment for the SDK contract tests: isolated data directories, a global config pointing at the local fake
 * model, and the development engine command. There are no platform packages in development, so the engine runs from
 * the repo's apps/cli source (the same way as the desktop app in development).
 */
import { mkdtemp, mkdir, rm, symlink } from "node:fs/promises"
import { execFileSync } from "node:child_process"
import os from "node:os"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { Filesystem } from "@merakcode/util/filesystem"

const repo = path.resolve(import.meta.dirname, "../../../../..")

/** Command prefix that runs the CLI from source: [node, ...args, apps/cli/src/index.ts] */
export const engine = [
  process.execPath,
  "--import",
  pathToFileURL(path.join(repo, "script/node/register.mjs")).href,
  "--disable-warning=ExperimentalWarning",
  path.join(repo, "apps/cli/src/index.ts"),
]

export type Sandbox = {
  root: string
  project: string
  /** Environment for the engine process: data directories, config, and networked background tasks turned off */
  env: Record<string, string>
  [Symbol.asyncDispose](): Promise<void>
}

export async function sandbox(model: string, extra: Record<string, unknown> = {}): Promise<Sandbox> {
  const root = await mkdtemp(path.join(os.tmpdir(), "merakcode-sdk-"))
  const project = path.join(root, "project")
  for (const dir of ["project", "home", "node_modules", "cache", "data", "logs"])
    await mkdir(path.join(root, dir), { recursive: true })
  execFileSync("git", ["init", "--quiet", project])
  await Filesystem.write(path.join(root, "cache/version"), "21")
  // The config directory's dependency check must resolve zod, which cannot be installed offline, so link it (a
  // junction needs no admin rights on Windows)
  await symlink(
    path.join(repo, "packages/engine/node_modules/zod"),
    path.join(root, "node_modules/zod"),
    "junction",
  ).catch(() => undefined)
  await Filesystem.write(
    path.join(root, "merakcode.json"),
    JSON.stringify({
      model: "alibaba-cn/qwen-plus",
      small_model: "alibaba-cn/qwen-plus",
      enabled_providers: ["alibaba-cn"],
      provider: { "alibaba-cn": { options: { apiKey: "fake", baseURL: model } } },
      memory: { auto_extract: false, auto_recall: false, session_memory: false, auto_dream: false },
      lsp: false,
      ...extra,
    }),
  )
  const env: Record<string, string> = {
    HOME: path.join(root, "home"),
    USERPROFILE: path.join(root, "home"),
    MERAKCODE_HOME: root,
    MERAKCODE_TEST_HOME: path.join(root, "home"),
    MERAKCODE_LOG_ROOT: path.join(root, "logs"),
    MERAKCODE_DISABLE_MODELS_FETCH: "1",
    MERAKCODE_SANDBOX_MODE: "off",
    MERAKCODE_DISABLE_LSP_DOWNLOAD: "1",
    MERAKCODE_DISABLE_CLAUDE_CODE: "1",
    MERAKCODE_DISABLE_EXTERNAL_SKILLS: "1",
    MERAKCODE_MODELS_PATH: path.join(repo, "packages/engine/test/tool/fixtures/models-api.json"),
  }
  return {
    root,
    project,
    env,
    [Symbol.asyncDispose]: () => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }),
  }
}
