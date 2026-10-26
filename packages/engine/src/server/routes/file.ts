import { Hono } from "hono"
import { describeRoute, resolver } from "hono-openapi"
import { validator } from "../validator"
import z from "zod"
import { File } from "../../file"
import { Ripgrep } from "../../file/ripgrep"
import { LSP } from "../../lsp"
import { Instance } from "../../project/instance"
import { Workspace } from "../../project/workspace"
import { lazy } from "../../util/lazy"
import { createHash } from "crypto"
import { unlink, rm } from "fs/promises"
import { errors } from "../error"
import { Filesystem } from "@merakcode/util/filesystem"
import { Checkout } from "../../project/checkout"
import { defer } from "@merakcode/util/defer"

/**
 * Multi-root write/create/delete/rename: the input may be an absolute UI path, `folderName/rel`, or relative to the
 * primary root. Instance.containsPath is the boundary, so writes outside the workspace are still rejected.
 * Reads and listings go through File.read/list, which allow previews outside the workspace, not through this.
 */
function resolveInWorkspace(input: string): string | undefined {
  const abs = Workspace.resolveToolPath(Instance.workspace, input).filepath
  if (!abs || !Instance.containsPath(abs)) return undefined
  return abs
}

export const FileRoutes = lazy(() =>
  new Hono()
    .get(
      "/find",
      describeRoute({
        summary: "Find text",
        description: "Search for text patterns across files in the project using ripgrep.",
        operationId: "find.text",
        responses: {
          200: {
            description: "Matches",
            content: {
              "application/json": {
                schema: resolver(Ripgrep.Match.shape.data.array()),
              },
            },
          },
        },
      }),
      validator(
        "query",
        z.object({
          pattern: z.string(),
        }),
      ),
      async (c) => {
        const pattern = c.req.valid("query").pattern
        // Multi-root: search every workspace folder (each with its own cwd) and merge the results.
        const roots = Workspace.searchRoots(Instance.workspace, undefined)
        const perRoot = Math.max(1, Math.ceil(10 / roots.length))
        const merged = []
        for (const cwd of roots) {
          const chunk = await Ripgrep.search({
            cwd,
            pattern,
            limit: perRoot,
          })
          merged.push(...chunk)
          if (merged.length >= 10) break
        }
        return c.json(merged.slice(0, 10))
      },
    )
    .get(
      "/find/file",
      describeRoute({
        summary: "Find files",
        description: "Search for files or directories by name or pattern in the project directory.",
        operationId: "find.files",
        responses: {
          200: {
            description: "File paths",
            content: {
              "application/json": {
                schema: resolver(z.string().array()),
              },
            },
          },
        },
      }),
      validator(
        "query",
        z.object({
          query: z.string(),
          dirs: z.enum(["true", "false"]).optional(),
          type: z.enum(["file", "directory"]).optional(),
          limit: z.coerce.number().int().min(1).max(200).optional(),
        }),
      ),
      async (c) => {
        const query = c.req.valid("query").query
        const dirs = c.req.valid("query").dirs
        const type = c.req.valid("query").type
        const limit = c.req.valid("query").limit
        const results = await File.search({
          query,
          // Matches the API max(200); the default of 10 would cut off later files (e.g. svg/txt).
          limit: limit ?? 200,
          dirs: dirs !== "false",
          type,
        })
        return c.json(results)
      },
    )
    .get(
      "/find/symbol",
      describeRoute({
        summary: "Find symbols",
        description: "Search for workspace symbols like functions, classes, and variables using LSP.",
        operationId: "find.symbols",
        responses: {
          200: {
            description: "Symbols",
            content: {
              "application/json": {
                schema: resolver(LSP.Symbol.array()),
              },
            },
          },
        },
      }),
      validator(
        "query",
        z.object({
          query: z.string(),
        }),
      ),
      async (c) => {
        /*
      const query = c.req.valid("query").query
      const result = await LSP.workspaceSymbol(query)
      return c.json(result)
      */
        return c.json([])
      },
    )
    .get(
      "/file",
      describeRoute({
        summary: "List files",
        description: "List files and directories in a specified path.",
        operationId: "file.list",
        responses: {
          200: {
            description: "Files and directories",
            content: {
              "application/json": {
                schema: resolver(File.Node.array()),
              },
            },
          },
        },
      }),
      validator(
        "query",
        z.object({
          path: z.string(),
        }),
      ),
      async (c) => {
        const path = c.req.valid("query").path
        const content = await File.list(path)
        return c.json(content)
      },
    )
    .get(
      "/file/content",
      describeRoute({
        summary: "Read file",
        description: "Read the content of a specified file.",
        operationId: "file.read",
        responses: {
          200: {
            description: "File content",
            content: {
              "application/json": {
                schema: resolver(File.Content),
              },
            },
          },
        },
      }),
      validator(
        "query",
        z.object({
          path: z.string(),
        }),
      ),
      async (c) => {
        const path = c.req.valid("query").path
        const content = await File.read(path)
        return c.json(content)
      },
    )
    .get(
      "/file/status",
      describeRoute({
        summary: "Get file status",
        description: "Get the git status of all files in the project.",
        operationId: "file.status",
        responses: {
          200: {
            description: "File status",
            content: {
              "application/json": {
                schema: resolver(File.Info.array()),
              },
            },
          },
        },
      }),
      async (c) => {
        const content = await File.status()
        return c.json(content)
      },
    )
    .put(
      "/file/content",
      describeRoute({
        summary: "Write file",
        description: "Write content to a file. Supports optional checksum for optimistic locking.",
        operationId: "file.write",
        responses: {
          200: {
            description: "File written successfully",
            content: { "application/json": { schema: resolver(z.object({ ok: z.boolean() })) } },
          },
          ...errors(400),
          409: {
            description: "The file changed or its checkout is switching branches",
            content: {
              "application/json": {
                schema: resolver(
                  z.union([Checkout.BlockedError.Schema, z.object({ error: z.string(), currentChecksum: z.string() })]),
                ),
              },
            },
          },
        },
      }),
      validator(
        "json",
        z.object({
          path: z.string(),
          content: z.string(),
          checksum: z.string().optional(),
        }),
      ),
      async (c) => {
        const { path, content, checksum } = c.req.valid("json")
        const abs = resolveInWorkspace(path)
        if (!abs) {
          return c.json({ error: "path outside project" }, 400)
        }
        const folder = Workspace.resolveFolder(Instance.workspace, abs)
        using _ = defer(
          Checkout.hold(folder ? (folder.worktree === "/" ? folder.path : folder.worktree) : Instance.worktree),
        )
        if (checksum) {
          const current = await Filesystem.readText(abs).catch(() => "")
          const currentChecksum = createHash("sha1").update(current).digest("hex")
          if (currentChecksum !== checksum) {
            return c.json({ error: "conflict", currentChecksum }, 409)
          }
        }
        await Filesystem.write(abs, content)
        return c.json({ ok: true })
      },
    )
    .delete(
      "/file",
      describeRoute({
        summary: "Delete file or directory",
        description: "Delete a file or directory at the specified path.",
        operationId: "file.delete",
        responses: {
          200: {
            description: "Deleted successfully",
            content: { "application/json": { schema: resolver(z.object({ ok: z.boolean() })) } },
          },
          ...errors(400),
          409: {
            description: "The checkout is switching branches",
            content: { "application/json": { schema: resolver(Checkout.BlockedError.Schema) } },
          },
        },
      }),
      validator(
        "json",
        z.object({
          path: z.string(),
        }),
      ),
      async (c) => {
        const { path } = c.req.valid("json")
        const abs = resolveInWorkspace(path)
        if (!abs) {
          return c.json({ error: "path outside project" }, 400)
        }
        const folder = Workspace.resolveFolder(Instance.workspace, abs)
        using _ = defer(
          Checkout.hold(folder ? (folder.worktree === "/" ? folder.path : folder.worktree) : Instance.worktree),
        )
        const file = abs
        if (await Filesystem.isFile(file)) {
          await unlink(abs)
        } else {
          await rm(abs, { recursive: true, force: true })
        }
        return c.json({ ok: true })
      },
    ),
)
