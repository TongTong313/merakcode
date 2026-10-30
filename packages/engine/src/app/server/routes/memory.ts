import { Hono } from "hono"
import { describeRoute, resolver } from "hono-openapi"
import { validator } from "../validator"
import z from "zod"
import { MemoryManage } from "../../../agent/memory/manage"
import { errors } from "../error"
import { lazy } from "@merakcode/util/lazy"

const Entry = z
  .object({
    filename: z.string().meta({ description: "Path relative to the memory root, same form as MEMORY.md index links" }),
    path: z.string().meta({ description: "Absolute path, so clients can open it in the editor" }),
    name: z.string().nullable(),
    description: z.string().nullable(),
    type: z.string().optional().meta({ description: "user / feedback / project / reference" }),
    mtimeMs: z.number(),
  })
  .meta({ ref: "MemoryEntry" })

const Snapshot = z
  .object({
    directory: z.string(),
    entrypoint: z.string(),
    index: z.string().meta({ description: "MEMORY.md body - the index that is injected into every turn" }),
    entries: Entry.array(),
  })
  .meta({ ref: "MemorySnapshot" })

/**
 * è®°å¿†ç®¡ç�†è·¯ç”±ï¼šé�¢å�‘ã€Œäººã€�çš„è¯»å†™é�¢ï¼ˆè®¾ç½®é¡µè®°å¿†é�¢æ�¿ / CLIï¼‰ï¼Œä¸Žé�¢å�‘æ¨¡åž‹çš„æ³¨å…¥è·¯å¾„æ— å…³ã€‚
 * è·¯å¾„å®‰å…¨ï¼ˆé˜²é��åŽ†ã€�å››ç±»åž‹ç›®å½•çº¦æ�Ÿã€�å†™å…¥å‰�å‡­è¯�æ‰«æ��ï¼‰å…¨éƒ¨ç”± MemoryManage â†’ MemoryAccess å…œä½�ï¼Œ
 * æœ¬å±‚å�ªå�š HTTP å½¢çŠ¶è½¬æ�¢ï¼Œè¶Šå‡ºè®°å¿†ç›®å½•çš„è¯·æ±‚ä¸€å¾‹ 400ã€‚
 */
export const MemoryRoutes = lazy(() =>
  new Hono()
    .get(
      "/",
      describeRoute({
        summary: "List memories",
        description:
          "List the project's memory directory, the MEMORY.md index body, and all topic memory entries with their frontmatter.",
        operationId: "memory.list",
        responses: {
          200: {
            description: "Memory snapshot",
            content: {
              "application/json": {
                schema: resolver(Snapshot),
              },
            },
          },
        },
      }),
      async (c) => {
        return c.json(await MemoryManage.list())
      },
    )
    .get(
      "/entry",
      describeRoute({
        summary: "Read a memory entry",
        description: "Read one memory file's raw content. Paths outside the memory directory are rejected.",
        operationId: "memory.read",
        responses: {
          200: {
            description: "Memory content",
            content: {
              "application/json": {
                schema: resolver(z.object({ path: z.string(), content: z.string() })),
              },
            },
          },
          ...errors(400),
        },
      }),
      validator("query", z.object({ path: z.string().meta({ description: "Absolute path of the memory file" }) })),
      async (c) => {
        const result = await MemoryManage.read(c.req.valid("query").path)
        if (!result.ok) return c.json({ error: result.error }, 400)
        return c.json(result.data)
      },
    )
    .delete(
      "/entry",
      describeRoute({
        summary: "Delete a memory entry",
        description:
          "Delete one memory file and prune the matching pointer line from MEMORY.md, so the index never points at a missing file.",
        operationId: "memory.remove",
        responses: {
          200: {
            description: "Deleted",
            content: {
              "application/json": {
                schema: resolver(z.object({ path: z.string() })),
              },
            },
          },
          ...errors(400),
        },
      }),
      validator("query", z.object({ path: z.string().meta({ description: "Absolute path of the memory file" }) })),
      async (c) => {
        const result = await MemoryManage.remove(c.req.valid("query").path)
        if (!result.ok) return c.json({ error: result.error }, 400)
        return c.json(result.data)
      },
    ),
)
