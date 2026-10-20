import path from "node:path"
import { Hono } from "hono"
import { describeRoute, resolver } from "hono-openapi"
import { validator } from "../validator"
import z from "zod"
import { generateText } from "ai"
import { Filesystem } from "@merakcode/util/filesystem"
import { Process } from "@merakcode/util/process"
import { Log } from "@merakcode/log/logger"
import { lazy } from "../../util/lazy"
import { Text } from "../../util/text"
import { Instance } from "../../project/instance"
import { Provider } from "../../provider/provider"
import { ProviderTransform } from "../../provider/transform"
import {
  buildChangeContext,
  buildCommitMessagePrompt,
  capDiff,
  cleanCommitMessage,
  formatSnippetContent,
  parseRecentCommits,
  pickStyleExamples,
  selectSnippetPaths,
  SNIPPET_MAX_BYTES,
} from "./commit-message-logic"
import { buildInlineEditPrompt, cleanInlineEditResult, validateInlineEditBody } from "./inline-edit-logic"

const log = Log.create({ service: "assist" })

/** Reads untracked file samples: a prefix of large files (marked truncated); unreadable files are skipped */
async function readUntrackedSnippets(repoDir: string, untrackedRaw: string) {
  const paths = untrackedRaw
    .split("\n")
    .map((f) => f.trim())
    .filter((f) => f.length > 0)
  const snippets: Array<{ path: string; content: string }> = []
  for (const rel of selectSnippetPaths(paths)) {
    try {
      const file = path.join(repoDir, rel)
      if (!(await Filesystem.isFile(file))) continue
      // Large files are not skipped: the first SNIPPET_MAX_BYTES still tell the model what they are.
      const fileTruncated = (await Filesystem.size(file)) > SNIPPET_MAX_BYTES
      const raw = fileTruncated
        ? new TextDecoder().decode(await Filesystem.readRange(file, 0, SNIPPET_MAX_BYTES))
        : await Filesystem.readText(file)
      snippets.push({ path: rel, content: formatSnippetContent(raw, { fileTruncated }) })
    } catch {
      // One unreadable file must not fail the whole generation.
    }
  }
  return snippets
}

export const AssistRoutes = lazy(() => {
  const app = new Hono()

  /**
   * Generates a git commit message (the commit action of the desktop review panel).
   * A fixed, non-agentic flow: run git for the staged diff (or the working tree when nothing is staged) and the last
   * 5 commit messages, then make one call to the small model, which follows the one-shot examples.
   * Never returns 500: no changes give an empty message; a failed model call gives an empty message plus `error`,
   * which the UI shows.
   */
  app.post(
    "/commit-message",
    describeRoute({
      summary: "Generate git commit message",
      operationId: "assist.commit.message",
      responses: {
        200: {
          description: "Generated commit message",
          content: {
            "application/json": {
              schema: resolver(z.object({ message: z.string(), error: z.string().optional() })),
            },
          },
        },
      },
    }),
    async (c) => {
      // The desktop app sends the project directory as x-merakcode-directory (each repository separately); the
      // server middleware builds the Instance from it, so the worktree is that repository's root.
      const repoDir = Instance.worktree

      const t0 = Date.now()
      try {
        // core.quotepath=false prints non-ASCII paths as UTF-8 instead of octal escapes like "\346\265\213..."
        // (same as File.status). -c applies to this process only and leaves the user's git config alone.
        const git = async (...args: string[]) =>
          (await Process.run(["git", "-c", "core.quotepath=false", ...args], { cwd: repoDir, nothrow: true })).text()
        const staged = await git("diff", "--staged")
        const working = await git("diff")
        const untracked = await git("ls-files", "--others", "--exclude-standard")
        const nameStatus = staged.trim()
          ? await git("diff", "--staged", "--name-status")
          : await git("diff", "--name-status")
        const snippets = staged.trim() ? [] : await readUntrackedSnippets(repoDir, untracked)

        const ctx = buildChangeContext({ staged, working, untracked, nameStatus, snippets })
        if (ctx.empty) return c.json({ message: "" })

        const logRaw = (
          await Process.run(["git", "log", "-n", "5", "--format=%B%x00"], { cwd: repoDir, nothrow: true })
        ).text()
        const recent = parseRecentCommits(logRaw)
        const examples = pickStyleExamples(recent)

        const def = await Provider.defaultModel()
        const model =
          (await Provider.getSmallModel(def.providerID)) ?? (await Provider.getModel(def.providerID, def.modelID))
        const language = await Provider.getLanguage(model)

        const { system, prompt } = buildCommitMessagePrompt({
          context: { source: ctx.source, summary: ctx.summary, diff: capDiff(ctx.diff) },
          examples,
          lang: await Text.lang(),
        })
        const result = await generateText({
          model: language,
          system,
          prompt,
          temperature: 0.2,
          maxOutputTokens: 512,
          providerOptions: ProviderTransform.providerOptions(model, ProviderTransform.completionOptions(model)),
          abortSignal: AbortSignal.timeout(15000),
        })

        const message = cleanCommitMessage(result.text ?? "")
        log.info("commit message generated", {
          model: `${model.providerID}/${model.id}`,
          source: ctx.source,
          recent: recent.length,
          ms: Date.now() - t0,
          len: message.length,
        })
        return c.json({ message })
      } catch (err) {
        log.warn("commit message failed", { ms: Date.now() - t0, error: err })
        return c.json({ message: "", error: err instanceof Error ? err.message : String(err) })
      }
    },
  )

  /**
   * Ctrl+K inline edit: rewrites the selection per the instruction in a single, non-agentic call.
   * Optional body.providerID/modelID apply to this request only; the default is Provider.defaultModel.
   * Never returns 500: on failure `text` is empty and `error` is set.
   */
  app.post(
    "/inline-edit",
    describeRoute({
      summary: "Inline edit selected code",
      operationId: "assist.inline.edit",
      responses: {
        200: {
          description: "Replacement text for the selection",
          content: {
            "application/json": {
              schema: resolver(
                z.object({
                  text: z.string(),
                  providerID: z.string().optional(),
                  modelID: z.string().optional(),
                  error: z.string().optional(),
                }),
              ),
            },
          },
        },
      },
    }),
    validator(
      "json",
      z.object({
        instruction: z.string(),
        selectedText: z.string(),
        language: z.string().optional(),
        path: z.string().optional(),
        providerID: z.string().optional(),
        modelID: z.string().optional(),
      }),
    ),
    async (c) => {
      const t0 = Date.now()
      try {
        const body = c.req.valid("json")
        const input = validateInlineEditBody(body)
        if (!input) return c.json({ text: "", error: "instruction and selection are required" })

        let model: Provider.Model
        if (body.providerID && body.modelID) {
          model = await Provider.getModel(body.providerID, body.modelID)
        } else {
          const def = await Provider.defaultModel()
          model = await Provider.getModel(def.providerID, def.modelID)
        }
        const language = await Provider.getLanguage(model)
        const { system, prompt } = buildInlineEditPrompt(input, await Text.lang())
        const result = await generateText({
          model: language,
          system,
          prompt,
          temperature: 0.1,
          maxOutputTokens: 4096,
          providerOptions: ProviderTransform.providerOptions(model, ProviderTransform.completionOptions(model)),
          abortSignal: AbortSignal.timeout(30000),
        })
        const text = cleanInlineEditResult(result.text ?? "", input.selectedText)
        log.info("inline edit generated", {
          model: `${model.providerID}/${model.id}`,
          ms: Date.now() - t0,
          len: text.length,
        })
        return c.json({
          text,
          providerID: model.providerID,
          modelID: model.id,
        })
      } catch (err) {
        log.warn("inline edit failed", { ms: Date.now() - t0, error: err })
        return c.json({ text: "", error: err instanceof Error ? err.message : String(err) })
      }
    },
  )

  return app
})
