import { sortModels } from "@merakcode/util/model"
import { Hono } from "hono"
import { describeRoute, resolver } from "hono-openapi"
import { validator } from "../validator"
import z from "zod"
import { Provider } from "../../../agent/model/provider"
import { ProviderAuth } from "../../../agent/model/auth"
import { ProviderVerify } from "../../../agent/model/verify"
import { Relay } from "../../../agent/model/relay"
import { mapValues } from "remeda"
import { errors } from "../error"
import { lazy } from "@merakcode/util/lazy"

async function buildProviderListResponse() {
  const filteredProviders = await Provider.getFilteredProviders()
  const connected = await Provider.list()
  const providers = Object.assign({}, filteredProviders, connected)
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
                    all: Provider.Info.array(),
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
          "Fetch connected providers' model lists into the local cache and rebuild providers. Returns false when every fetch fails and the cached catalog stays in use.",
        operationId: "provider.catalog.refresh",
        responses: {
          200: {
            description: "Whether the catalog was refreshed",
            content: { "application/json": { schema: resolver(z.boolean()) } },
          },
        },
      }),
      async (c) => c.json((await Provider.refreshCatalog(undefined, true)).updated),
    )
    .post(
      "/refresh",
      describeRoute({
        summary: "Refresh providers",
        description: "Rebuild the provider list from the saved credentials and config.",
        operationId: "provider.refresh",
        responses: {
          200: {
            description: "Refresh completed",
            content: { "application/json": { schema: resolver(z.boolean()) } },
          },
        },
      }),
      async (c) => {
        Provider.invalidateAll()
        // Rebuild the loaders now.
        await Provider.list()
        await Provider.publishChanged({ reason: "refreshed" })
        return c.json(true)
      },
    )
    .post(
      "/relay/discover",
      describeRoute({
        summary: "List models at a relay",
        description: "Ask a relay for the models a key can use, and fill in limits the relay did not return.",
        operationId: "provider.relay.discover",
        responses: {
          200: {
            description: "Models the relay returned",
            content: {
              "application/json": {
                schema: resolver(
                  z.union([z.object({ models: z.array(Relay.Listed) }), z.object({ error: z.string() })]),
                ),
              },
            },
          },
        },
      }),
      validator(
        "json",
        z.object({
          baseURL: z.string(),
          key: z.string(),
          kind: Relay.Kind,
        }),
      ),
      async (c) => c.json(await Relay.discover(c.req.valid("json"))),
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
