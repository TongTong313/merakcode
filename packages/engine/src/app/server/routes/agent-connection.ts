import { Hono } from "hono"
import { describeRoute, resolver } from "hono-openapi"
import { z } from "zod"
import { Product, products, configuredProducts } from "../../../agent/external/catalog"
import { lazy } from "@merakcode/util/lazy"
import { validator } from "../validator"
import { ProductChange, changeProduct } from "../../../agent/external/product-config"
import { adapterOf } from "../../../agent/external/adapters"
import { discoverModels, runExternal } from "../../../agent/external/runtime"
import { HTTPException } from "hono/http-exception"
import { Text } from "../../../agent/prompt/text"
import os from "node:os"
import path from "node:path"
import fs from "node:fs/promises"
import { productState, withProduct } from "../../../agent/external/state"
import { ErrorCode } from "@merakcode/util/error-code"

const Models = z
  .object({
    models: z.array(z.object({ id: z.string(), providerID: z.string().optional(), title: z.string() })),
    allowCustomID: z.boolean(),
  })
  .meta({ ref: "AgentConnectionModels" })
const Verification = z
  .object({
    productID: z.string(),
    revision: z.number(),
    status: z.enum(["passed", "failed"]),
    requestedModel: z.object({ id: z.string(), providerID: z.string().optional() }).optional(),
    actualModel: z.object({ id: z.string(), providerID: z.string().optional() }).optional(),
    streamingObserved: z.boolean(),
    checkedAt: z.number(),
    error: z.object({ code: z.string(), message: z.string() }).optional(),
  })
  .meta({ ref: "AgentConnectionVerification" })

export const AgentConnectionRoutes = lazy(() =>
  new Hono()
    .get(
      "/product",
      describeRoute({
        summary: "List global agent connections",
        operationId: "agentConnection.products",
        responses: {
          200: { description: "Products", content: { "application/json": { schema: resolver(Product.array()) } } },
        },
      }),
      validator("query", z.object({ refresh: z.enum(["true", "false"]).optional() })),
      async (c) => c.json(await products({ refresh: c.req.valid("query").refresh === "true" })),
    )
    .post(
      "/product",
      describeRoute({
        summary: "Change a global agent connection",
        operationId: "agentConnection.product.change",
        responses: {
          200: { description: "Products", content: { "application/json": { schema: resolver(Product.array()) } } },
        },
      }),
      validator("json", ProductChange),
      async (c) => {
        await changeProduct(c.req.valid("json"))
        return c.json(await products())
      },
    )
    .get(
      "/product/:productID/model",
      describeRoute({
        summary: "Discover models for an agent connection",
        operationId: "agentConnection.models",
        responses: { 200: { description: "Models", content: { "application/json": { schema: resolver(Models) } } } },
      }),
      validator("param", z.object({ productID: z.string() })),
      async (c) => {
        const product = (await configuredProducts()).find((item) => item.id === c.req.valid("param").productID)
        if (!product)
          throw new HTTPException(404, { message: await Text.pick({ zh: "没有这个产品", en: "Product not found" }) })
        const driven = await adapterOf(product)
        if (!driven) return c.json({ models: [], allowCustomID: true })
        return c.json(await discoverModels({ ...driven, cwd: os.tmpdir() }))
      },
    )
    .post(
      "/product/:productID/verify",
      describeRoute({
        summary: "Verify a saved agent connection",
        operationId: "agentConnection.verify",
        responses: {
          200: {
            description: "Verification result",
            content: { "application/json": { schema: resolver(Verification) } },
          },
        },
      }),
      validator("param", z.object({ productID: z.string() })),
      validator("json", z.object({ expectedRevision: z.number().int().nonnegative() })),
      async (c) => {
        const { productID } = c.req.valid("param")
        const { expectedRevision } = c.req.valid("json")
        const product = (await configuredProducts()).find((item) => item.id === productID)
        if (!product)
          throw new HTTPException(404, { message: await Text.pick({ zh: "没有这个产品", en: "Product not found" }) })
        const state = await productState(productID)
        if (state.revision !== expectedRevision || !state.enabled)
          throw new HTTPException(409, {
            message: await Text.pick({
              zh: "配置已变化或产品已关闭，请刷新后重新验证",
              en: "The configuration changed or the product is disabled; refresh before verifying",
            }),
          })
        if (product.adapter !== "claude")
          throw new HTTPException(400, {
            message: await Text.pick({
              zh: "此接入不支持禁用工具的纯文本验证",
              en: "This connection does not support text-only verification with tools disabled",
            }),
          })
        const driven = await adapterOf({ ...product, args: [...product.args, "--tools", ""] })
        if (!driven)
          throw new HTTPException(400, {
            message: await Text.pick({ zh: "产品尚未安装", en: "The product is not installed" }),
          })
        const directory = await fs.mkdtemp(path.join(os.tmpdir(), "merakcode-verify-"))
        const controller = new AbortController()
        const timeout = setTimeout(() => controller.abort(), 30_000)
        let streamingObserved = false
        const report: z.infer<typeof Verification> = {
          productID,
          revision: expectedRevision,
          requestedModel: product.model,
          status: "failed",
          streamingObserved: false,
          checkedAt: Date.now(),
        }
        try {
          const runID = crypto.randomUUID()
          const admitted = await withProduct(productID, async (current) => {
            if (!current.enabled || current.revision !== expectedRevision)
              throw new HTTPException(409, {
                message: await Text.pick({
                  zh: "配置在验证开始前已变化，请刷新后重试",
                  en: "The configuration changed before verification; refresh and try again",
                }),
              })
            return {
              result: runExternal({
                ...driven,
                runID,
                sessionID: `verification:${runID}`,
                task: {
                  prompt: "Reply with a short synthetic greeting. Do not use any tools or access files.",
                  cwd: directory,
                  mode: "readonly",
                  model: product.model,
                },
                abort: controller.signal,
                host: {
                  step: () => undefined,
                  textDelta: ({ delta }) => {
                    streamingObserved ||= delta.length > 0
                  },
                  permission: async () => ({ allow: false, message: "Tools are disabled for verification" }),
                  question: async () => [],
                },
              }),
            }
          })
          const result = await admitted.result
          if (!result.text.trim())
            throw new Error(await Text.pick({ zh: "产品未返回回复", en: "The product returned no reply" }))
          report.status = "passed"
          report.actualModel = result.actualModel
        } catch (error) {
          report.error = {
            code: ErrorCode.CATALOG.EXTERNAL_ADAPTER_FAILED.code,
            message:
              error instanceof Error ? error.message : await Text.pick({ zh: "验证失败", en: "Verification failed" }),
          }
        } finally {
          clearTimeout(timeout)
          await fs.rm(directory, { recursive: true, force: true })
        }
        if ((await productState(productID)).revision !== expectedRevision)
          throw new HTTPException(409, {
            message: await Text.pick({
              zh: "配置已变化，请重新验证",
              en: "The configuration changed; verify it again",
            }),
          })
        report.streamingObserved = streamingObserved
        report.checkedAt = Date.now()
        return c.json(report)
      },
    ),
)
