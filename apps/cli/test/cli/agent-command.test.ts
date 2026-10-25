/**
 * merak agent: create has the model generate an agent from a description and writes it as markdown in the project;
 * list shows all agents. The model is a local fake server (OpenAI-compatible) that replies with fixed JSON
 */
import { expect, test } from "vitest"
import path from "path"
import matter from "gray-matter"
import { Filesystem } from "@merakcode/util/filesystem"
import { Http } from "@merakcode/util/http"
import { Process } from "@merakcode/util/process"
import { cli, tmpdir } from "../fixture/fixture"

async function model() {
  const server = await Http.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch() {
      const content = JSON.stringify({ identifier: "reviewer", whenToUse: "Review diffs", systemPrompt: "You review." })
      return Response.json({
        id: "chatcmpl-1",
        object: "chat.completion",
        created: 0,
        model: "qwen-plus",
        choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
        usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 },
      })
    },
  })
  return { url: `${server.url.origin}/v1`, [Symbol.asyncDispose]: () => server.stop(true) }
}

async function merak(cwd: string, ...args: string[]) {
  const proc = Process.spawn([...cli, ...args], {
    cwd,
    env: { ...process.env, MERAKCODE_LOCALE: "en", MERAKCODE_DISABLE_CATALOG_FETCH: "1" },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  })
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  return { stdout, stderr, code }
}

test(
  "create writes an agent file from the description with only the selected tools; list shows it",
  { timeout: 120_000 },
  async () => {
    await using fake = await model()
    await using tmp = await tmpdir({
      config: {
        enabled_providers: ["alibaba-cn"],
        provider: { "alibaba-cn": { options: { apiKey: "test-key", baseURL: fake.url } } },
      },
    })

    const created = await merak(
      tmp.path,
      "agent",
      "create",
      "--path",
      path.join(tmp.path, ".merakcode"),
      "--description",
      "reviews diffs",
      "--mode",
      "subagent",
      "--tools",
      "read,grep",
      "--model",
      "alibaba-cn/qwen-plus",
    )
    expect(created.code).toBe(0)
    const file = created.stdout.trim()
    expect(path.relative(path.join(tmp.path, ".merakcode", "agent", "reviewer.md"), file)).toBe("")
    const parsed = matter(await Filesystem.readText(file))
    expect(parsed.content.trim()).toBe("You review.")
    expect(parsed.data).toEqual({
      description: "Review diffs",
      mode: "subagent",
      tools: { bash: false, write: false, edit: false, ls: false, glob: false, webfetch: false },
    })

    const listed = await merak(tmp.path, "agent", "list")
    expect(listed.code).toBe(0)
    expect(listed.stdout).toContain("reviewer (subagent)")
    expect(listed.stdout).toContain("build (primary)")
  },
)
