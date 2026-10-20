import { sortModels } from "@merakcode/util/model"
import { Hono } from "hono"
import { describeRoute, resolver } from "hono-openapi"
import { validator } from "../validator"
import z from "zod"
import { Provider } from "../../provider/provider"
import { ModelsDev } from "../../provider/models"
import { ProviderAuth } from "../../provider/auth"
import { ProviderVerify } from "../../provider/verify"
import { Env } from "../../env"
import { mapValues } from "remeda"
import { errors } from "../error"
import { lazy } from "../../util/lazy"

async function buildProviderListResponse() {
  const filteredProviders = await Provider.getFilteredProviders()
  const connected = await Provider.list()
  const providers = Object.assign(
    mapValues(filteredProviders, (x) => Provider.fromModelsDevProvider(x)),
    connected,
  )
  return {
    all: Provider.sortProvidersByPriority(Object.values(providers)),
    default: mapValues(providers, (item) => sortModels(Object.values(item.models))[0]?.id ?? ""),
    // Same order as default model selection, so a client picking the first connected provider agrees with the engine.
    connected: Provider.rank(Object.values(connected)).map((p) => p.id),
  }
}

export const ProviderRoutes = lazy(() =>
  new Hono()
    .get(
      "/",
      describeRoute({
        summary: "List providers",
        description: "Get a list of all available AI providers, including both available and connected ones.",
        operationId: "provider.list",
        responses: {
          200: {
            description: "List of providers",
            content: {
              "application/json": {
                schema: resolver(
                  z.object({
                    all: ModelsDev.Provider.array(),
                    default: z.record(z.string(), z.string()),
                    connected: z.array(z.string()),
                  }),
                ),
              },
            },
          },
        },
      }),
      async (c) => {
        return c.json(await buildProviderListResponse())
      },
    )
    .get(
      "/auth",
      describeRoute({
        summary: "Get provider auth methods",
        description: "Retrieve available authentication methods for all AI providers.",
        operationId: "provider.auth",
        responses: {
          200: {
            description: "Provider auth methods",
            content: {
              "application/json": {
                schema: resolver(z.record(z.string(), z.array(ProviderAuth.Method))),
              },
            },
          },
        },
      }),
      async (c) => {
        return c.json(await ProviderAuth.methods())
      },
    )
    .post(
      "/catalog/refresh",
      describeRoute({
        summary: "Refresh model catalog",
        description:
          "Fetch the latest model catalog (models.dev) into the local cache and rebuild providers. Returns false when the fetch fails and the cached catalog stays in use.",
        operationId: "provider.catalog.refresh",
        responses: {
          200: {
            description: "Whether the catalog was refreshed",
            content: { "application/json": { schema: resolver(z.boolean()) } },
          },
        },
      }),
      async (c) => {
        const refreshed = await ModelsDev.refresh()
        if (refreshed) Provider.invalidateAll()
        return c.json(refreshed)
      },
    )
    .post(
      "/refresh",
      describeRoute({
        summary: "Refresh provider environment",
        description: "Re-read provider-related env vars from system and invalidate provider cache.",
        operationId: "provider.refresh",
        responses: {
          200: {
            description: "Refresh completed",
            content: { "application/json": { schema: resolver(z.boolean()) } },
          },
        },
      }),
      async (c) => {
        const keys = await Provider.getAllEnvKeys()
        await Env.reload(keys)
        Provider.invalidateAll()
        // Rebuild the loaders now.
        await Provider.list()
        await Provider.publishChanged({ reason: "refreshed" })
        return c.json(true)
      },
    )
    .post(
      "/:providerID/verify",
      describeRoute({
        summary: "Verify provider",
        description: "Send a minimal request with the provider's small model to check that the saved credentials work.",
        operationId: "provider.verify",
        responses: {
          200: {
            description: "Verification result",
            content: {
              "application/json": {
                schema: resolver(
                  z.union([
                    z.object({ ok: z.literal(true), model: z.string() }),
                    z.object({ ok: z.literal(false), error: z.string() }),
                  ]),
                ),
              },
            },
          },
        },
      }),
      validator("param", z.object({ providerID: z.string().meta({ description: "Provider ID" }) })),
      async (c) => c.json(await ProviderVerify.run(c.req.valid("param").providerID)),
    )
    .post(
      "/:providerID/oauth/prompt",
      describeRoute({
        summary: "Next OAuth prompt",
        description:
          "Given the answers collected so far, return the next question the auth method asks before authorizing (with the validation error when the last answer was rejected). No prompt means all answers are collected; pass them to provider.oauth.authorize.",
        operationId: "provider.oauth.prompt",
        responses: {
          200: {
            description: "Next prompt",
            content: {
              "application/json": {
                schema: resolver(z.object({ prompt: ProviderAuth.Prompt.optional(), error: z.string().optional() })),
              },
            },
          },
        },
      }),
      validator("param", z.object({ providerID: z.string().meta({ description: "Provider ID" }) })),
      validator(
        "json",
        z.object({
          method: z.number().meta({ description: "Auth method index" }),
          inputs: z.record(z.string(), z.string()),
        }),
      ),
      async (c) =>
        c.json(await ProviderAuth.prompt({ providerID: c.req.valid("param").providerID, ...c.req.valid("json") })),
    )
    .post(
      "/:providerID/oauth/authorize",
      describeRoute({
        summary: "OAuth authorize",
        description: "Initiate OAuth authorization for a specific AI provider to get an authorization URL.",
        operationId: "provider.oauth.authorize",
        responses: {
          200: {
            description: "Authorization URL and method",
            content: {
              "application/json": {
                schema: resolver(ProviderAuth.Authorization.optional()),
              },
            },
          },
          ...errors(400),
        },
      }),
      validator(
        "param",
        z.object({
          providerID: z.string().meta({ description: "Provider ID" }),
        }),
      ),
      validator(
        "json",
        z.object({
          method: z.number().meta({ description: "Auth method index" }),
          inputs: z
            .record(z.string(), z.string())
            .optional()
            .meta({ description: "Answers to the method prompts (see provider.oauth.prompt)" }),
        }),
      ),
      async (c) => {
        const providerID = c.req.valid("param").providerID
        const { method, inputs } = c.req.valid("json")
        const result = await ProviderAuth.authorize({
          providerID,
          method,
          inputs,
        })
        return c.json(result)
      },
    )
    .post(
      "/:providerID/oauth/callback",
      describeRoute({
        summary: "OAuth callback",
        description: "Handle the OAuth callback from a provider after user authorization.",
        operationId: "provider.oauth.callback",
        responses: {
          200: {
            description: "OAuth callback processed successfully",
            content: {
              "application/json": {
                schema: resolver(z.boolean()),
              },
            },
          },
          ...errors(400),
        },
      }),
      validator(
        "param",
        z.object({
          providerID: z.string().meta({ description: "Provider ID" }),
        }),
      ),
      validator(
        "json",
        z.object({
          method: z.number().meta({ description: "Auth method index" }),
          code: z.string().optional().meta({ description: "OAuth authorization code" }),
        }),
      ),
      async (c) => {
        const providerID = c.req.valid("param").providerID
        const { method, code } = c.req.valid("json")
        const saved = await ProviderAuth.callback({
          providerID,
          method,
          code,
        })
        // OAuth also writes credentials; invalidate the cache, or provider.list still shows "not connected".
        Provider.invalidateAll()
        await Provider.publishChanged({ providerID: saved, reason: "connected" })
        return c.json(true)
      },
    ),
)
