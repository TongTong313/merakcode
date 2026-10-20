import { readFileSync } from "node:fs"
import path from "node:path"
import { describe, expect, test } from "vitest"
import { createMerakCodeClient } from "@merakcode/sdk/client"
import { operations, render, type Spec } from "../script/reference"

const root = path.resolve(import.meta.dirname, "..")
const spec = JSON.parse(readFileSync(path.join(root, "../openapi.json"), "utf8")) as Spec
const generated = readFileSync(path.join(root, "src/client/gen/sdk.gen.ts"), "utf8")

describe("operations", () => {
  const small: Spec = {
    paths: {
      "/auth/{providerID}": {
        put: {
          operationId: "auth.set",
          summary: "Set auth",
          description: "Store a credential",
          parameters: [
            { in: "path", name: "providerID", required: true, schema: { type: "string" }, description: "Provider id" },
            { in: "query", name: "directory", schema: { type: "string" } },
          ],
          requestBody: {
            required: true,
            content: { "application/json": { schema: { $ref: "#/components/schemas/Auth" } } },
          },
          responses: { "200": { description: "ok", content: { "application/json": { schema: { type: "boolean" } } } } },
        },
      },
      "/session/{sessionID}/prompt_async": {
        post: {
          operationId: "session.prompt_async",
          summary: "Send async message",
          parameters: [{ in: "path", name: "sessionID", required: true, schema: { type: "string" } }],
          requestBody: {
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["parts"],
                  properties: {
                    agent: { type: "string", description: "Agent name" },
                    parts: {
                      type: "array",
                      items: {
                        anyOf: [
                          { $ref: "#/components/schemas/TextPartInput" },
                          { $ref: "#/components/schemas/FilePartInput" },
                        ],
                      },
                    },
                  },
                },
              },
            },
          },
          responses: { "204": { description: "accepted" } },
        },
      },
    },
  }
  const code = `
  public set<ThrowOnError extends boolean = false>(parameters: { providerID: string; auth: Auth3 }) {
    const params = buildClientParams([parameters], [{ args: [{ in: "path", key: "providerID" }, { key: "auth", map: "body" }] }])
    return (options?.client ?? this.client).put<AuthSetResponses, AuthSetErrors, ThrowOnError>({
      url: "/auth/{providerID}",
  }
  public promptAsync<ThrowOnError extends boolean = false>(parameters: {}) {
    const params = buildClientParams([parameters], [{ args: [
      { in: "path", key: "sessionID" },
      { in: "body", key: "agent" },
      { in: "body", key: "parts" },
    ] }])
    return (options?.client ?? this.client).post<A, B, ThrowOnError>({
      url: "/session/{sessionID}/prompt_async",
  }`
  const list = operations(small, code)

  test("call path comes from the operationId, with the last part in camelCase", () => {
    expect(list.map((op) => op.call.join("."))).toEqual(["auth.set", "session.promptAsync"])
  })

  test("a body passed whole keeps the generated key and the schema name as its type", () => {
    expect(list[0]!.params).toEqual([
      { name: "providerID", type: "string", required: true, description: "Provider id" },
      { name: "auth", type: "Auth", required: true, description: "" },
    ])
  })

  test("a flattened body lists each field with its own type and required flag", () => {
    expect(list[1]!.params).toEqual([
      { name: "sessionID", type: "string", required: true, description: "" },
      { name: "agent", type: "string", required: false, description: "Agent name" },
      { name: "parts", type: "(TextPartInput | FilePartInput)[]", required: true, description: "" },
    ])
  })

  test("return type is the first 2xx response, or nothing", () => {
    expect(list.map((op) => op.returns)).toEqual(["boolean", ""])
  })

  test("fails loudly when the generated client has no method for an operation", () => {
    expect(() => operations(small, "")).toThrow(/auth\.set/)
  })
})

describe("reference.md", () => {
  const list = operations(spec, generated)

  test("covers every operation in openapi.json", () => {
    const ids = Object.values(spec.paths).flatMap((item) => Object.values(item).map((op) => op.operationId))
    const text = render(list)
    expect(list.map((op) => op.id).sort()).toEqual([...ids].sort())
    expect(ids.filter((id) => !text.includes(`\`${id}\``))).toEqual([])
  })

  test("event streams say what each event is", () => {
    expect(list.find((op) => op.id === "event.subscribe")?.returns).toBe("stream of Event")
  })

  test("inline objects show their fields, optional ones marked", () => {
    expect(list.find((op) => op.id === "global.health")?.returns).toBe("{ healthy: true; version: string }")
    const search = list.find((op) => op.id === "global.session.search")
    expect(search?.params.map((param) => param.name)).toEqual(["search", "roots", "limit"])
  })

  test("table of contents links use GitHub's lower-case anchors", () => {
    expect(render(list)).toContain("- [mcpManagement](#mcpmanagement)")
  })

  test("every documented method exists on a real client", () => {
    const client = createMerakCodeClient({ baseUrl: "http://127.0.0.1:1" }) as unknown as Record<string, unknown>
    const missing = list.filter((op) => {
      const method = op.call.reduce<unknown>(
        (value, key) => (value as Record<string, unknown> | undefined)?.[key],
        client,
      )
      return typeof method !== "function"
    })
    expect(missing.map((op) => op.id)).toEqual([])
  })
})
