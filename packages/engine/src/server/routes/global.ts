import { Hono } from "hono"
import { describeRoute, resolver } from "hono-openapi"
import { validator } from "../validator"
import { streamSSE } from "hono/streaming"
import z from "zod"
import { BusEvent } from "../../bus/bus-event"
import { GlobalBus } from "../../bus/global"
import { Instance } from "../../project/instance"
import { Installation } from "../../installation"
import { Log } from "@merakcode/log/logger"
import { Config } from "../../config/config"
import { Provider } from "../../provider/provider"
import { errors } from "../error"
import { Agent } from "../../agent/agent"
import { Session } from "../../session"
import { SessionStats } from "../../session/stats"
import { Storage } from "../../storage/storage"
import { createSessionListCache, shouldInvalidateSessionListCache } from "../session-list-cache"
import { EventStream } from "../event-stream"

const log = Log.create({ service: "server" })

/** Consecutive searches reuse the list instead of reading everything again; session events or the TTL invalidate it */
const SESSION_LIST_CACHE_TTL_MS = 3_000

/**
 * Reads all locally stored sessions, independent of the open workspace.
 * An unreadable project record or session file is skipped so one bad entry does not break the whole search.
 */
async function loadAllSessions(): Promise<Session.Info[]> {
  const keys = await Storage.list(["session"])
  const sessions = await Promise.all(
    keys.map(async (key) => {
      const parsed = Session.Info.safeParse(await Storage.read<unknown>(key).catch(() => undefined))
      if (!parsed.success) return undefined
      if (parsed.data.id !== key.at(-1)) return undefined
      return parsed.data
    }),
  )
  return sessions.filter((session): session is Session.Info => !!session)
}

const sessionListCache = createSessionListCache({
  ttlMs: SESSION_LIST_CACHE_TTL_MS,
  load: loadAllSessions,
})

GlobalBus.on("event", (event) => {
  if (shouldInvalidateSessionListCache(event?.payload?.type)) sessionListCache.invalidate()
})

function listAllSessions(): Promise<Session.Info[]> {
  return sessionListCache.get()
}

export const GlobalDisposedEvent = BusEvent.define("global.disposed", z.object({}))

export const GlobalRoutes = () =>
  new Hono()
    .get(
      "/health",
      describeRoute({
        summary: "Get health",
        description: "Get health information about the MerakCode server.",
        operationId: "global.health",
        responses: {
          200: {
            description: "Health information",
            content: {
              "application/json": {
                schema: resolver(z.object({ healthy: z.literal(true), version: z.string() })),
              },
            },
          },
        },
      }),
      async (c) => {
        return c.json({ healthy: true, version: Installation.VERSION })
      },
    )
    .get(
      "/session/search",
      describeRoute({
        summary: "Search sessions across all projects",
        description: "Search session titles across every persisted MerakCode project, including closed workspaces.",
        operationId: "global.session.search",
        responses: {
          200: {
            description: "Matching sessions sorted by most recently updated",
            content: {
              "application/json": {
                schema: resolver(Session.Info.array()),
              },
            },
          },
        },
      }),
      validator(
        "query",
        z.object({
          search: z.string().optional(),
          roots: z.coerce.boolean().optional(),
          limit: z.coerce.number().optional(),
        }),
      ),
      async (c) => {
        const query = c.req.valid("query")
        const term = query.search?.toLowerCase()
        const sessions = (await listAllSessions()).sort((a, b) => b.time.updated - a.time.updated)
        const filtered = sessions.filter((session) => {
          if (query.roots && session.parentID) return false
          if (term !== undefined && !session.title.toLowerCase().includes(term)) return false
          return true
        })
        return c.json(query.limit === undefined ? filtered : filtered.slice(0, query.limit))
      },
    )
    .get(
      "/stats",
      describeRoute({
        summary: "Usage statistics",
        description:
          "Aggregate sessions, messages, cost, token usage, tool and model usage across every persisted project.",
        operationId: "global.stats",
        responses: {
          200: {
            description: "Usage statistics",
            content: {
              "application/json": {
                schema: resolver(SessionStats.Info),
              },
            },
          },
        },
      }),
      validator("query", SessionStats.Query),
      async (c) => c.json(await SessionStats.aggregate(await listAllSessions(), c.req.valid("query"))),
    )
    .get(
      "/event",
      describeRoute({
        summary: "Get global events",
        description: "Subscribe to global events from the MerakCode system using server-sent events.",
        operationId: "global.event",
        responses: {
          200: {
            description: "Event stream",
            content: {
              "text/event-stream": {
                schema: resolver(
                  z
                    .object({
                      directory: z.string(),
                      payload: BusEvent.payloads(),
                    })
                    .meta({
                      ref: "GlobalEvent",
                    }),
                ),
              },
            },
          },
        },
      }),
      async (c) => {
        log.info("global event connected")
        return streamSSE(c, async (stream) => {
          await EventStream.run({
            stream,
            subscribe: (listener) => {
              GlobalBus.on("event", listener)
              return () => GlobalBus.off("event", listener)
            },
            connected: {
              payload: {
                type: "server.connected",
                properties: {},
              },
            },
            heartbeat: {
              payload: {
                type: "server.heartbeat",
                properties: {},
              },
            },
            onClose: () => log.info("global event disconnected"),
          })
        })
      },
    )
    .get(
      "/config",
      describeRoute({
        summary: "Get global configuration",
        description: "Retrieve the current global MerakCode configuration settings and preferences.",
        operationId: "global.config.get",
        responses: {
          200: {
            description: "Get global config info",
            content: {
              "application/json": {
                schema: resolver(Config.Info),
              },
            },
          },
        },
      }),
      async (c) => {
        return c.json(await Config.getGlobal())
      },
    )
    .patch(
      "/config",
      describeRoute({
        summary: "Update global configuration",
        description:
          "Update global MerakCode configuration settings and preferences. " +
          "With skipDispose=true only the config cache is refreshed (the Instance is not disposed and global.disposed is not broadcast), " +
          "for small changes that take effect without restarting sessions (such as the TUI model choice).",
        operationId: "global.config.update",
        responses: {
          200: {
            description: "Successfully updated global config",
            content: {
              "application/json": {
                schema: resolver(Config.Info),
              },
            },
          },
          ...errors(400),
        },
      }),
      validator("json", Config.Info),
      validator(
        "query",
        z.object({
          // hono-openapi query values are strings, so accept "true"/"1" and the like.
          skipDispose: z
            .union([z.literal("true"), z.literal("1"), z.literal("false"), z.literal("0")])
            .optional()
            .transform((v) => v === "true" || v === "1"),
        }),
      ),
      async (c) => {
        const config = c.req.valid("json")
        const { skipDispose } = c.req.valid("query")
        const next = await Config.updateGlobal(config, { skipDispose })
        // Like the safety route: with skipDispose, invalidate the derived Agent cache so the next Agent.get(...)
        // returns Agent.Info built from the new config.
        if (skipDispose) Agent.invalidateAll()
        return c.json(next)
      },
    )
    .delete(
      "/config/provider/:providerID",
      describeRoute({
        summary: "Delete provider from global config",
        description: "Remove a provider entry from global merakcode.json and clear dangling model references.",
        operationId: "global.config.deleteProvider",
        responses: {
          200: {
            description: "Provider removed",
            content: {
              "application/json": {
                schema: resolver(z.boolean()),
              },
            },
          },
        },
      }),
      validator("param", z.object({ providerID: z.string() })),
      validator(
        "query",
        z.object({
          // Delete-then-write during an edit passes clearReferences=false: only the provider subtree is removed and
          // references that are still valid are kept.
          clearReferences: z
            .union([z.literal("true"), z.literal("1"), z.literal("false"), z.literal("0")])
            .optional()
            .transform((v) => (v === undefined ? undefined : v === "true" || v === "1")),
        }),
      ),
      async (c) => {
        const { providerID } = c.req.valid("param")
        const { clearReferences } = c.req.valid("query")
        await Config.deleteProvider(providerID, "global", { clearReferences })
        Provider.invalidateAll()
        return c.json(true)
      },
    )
    .delete(
      "/config/provider/:providerID/model/:modelID",
      describeRoute({
        summary: "Delete model from global provider config",
        description: "Remove a single model from a provider in global config and clear dangling references.",
        operationId: "global.config.deleteProviderModel",
        responses: {
          200: {
            description: "Provider model removed",
            content: {
              "application/json": {
                schema: resolver(z.boolean()),
              },
            },
          },
        },
      }),
      validator(
        "param",
        z.object({
          providerID: z.string(),
          modelID: z.string(),
        }),
      ),
      async (c) => {
        const { providerID, modelID } = c.req.valid("param")
        await Config.deleteProviderModel(providerID, modelID, "global")
        Provider.invalidateAll()
        return c.json(true)
      },
    )
    .post(
      "/dispose",
      describeRoute({
        summary: "Dispose instance",
        description: "Clean up and dispose all MerakCode instances, releasing all resources.",
        operationId: "global.dispose",
        responses: {
          200: {
            description: "Global disposed",
            content: {
              "application/json": {
                schema: resolver(z.boolean()),
              },
            },
          },
        },
      }),
      async (c) => {
        await Instance.disposeAll()
        GlobalBus.emit("event", {
          directory: "global",
          payload: {
            type: GlobalDisposedEvent.type,
            properties: {},
          },
        })
        return c.json(true)
      },
    )
