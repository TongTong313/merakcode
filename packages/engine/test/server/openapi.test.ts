import { expect, test } from "vitest"
import { Server } from "@merakcode/engine/app/server/server"

test("the OpenAPI spec is self-contained and model names are plain strings so custom provider models fit", async () => {
  const spec = await Server.openapi()
  const refs: string[] = []
  JSON.stringify(spec, (key, value) => {
    if (key === "$ref" && typeof value === "string") refs.push(value)
    return value
  })
  expect(refs.filter((ref) => !ref.startsWith("#/"))).toEqual([])

  const config = spec.components?.schemas?.["Config"] as { properties: Record<string, unknown> }
  expect(config.properties["model"]).toMatchObject({ type: "string" })
}, 60_000)
