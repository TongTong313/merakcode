import { describe, expect, test } from "vitest"
import { Hono } from "hono"
import { generateSpecs } from "hono-openapi"
import { Server } from "../server"
import { AssistRoutes } from "./assist"

describe("assist.inline.edit route", () => {
  test("an empty instruction or selection returns 200 with empty text and a reason, not 500", async () => {
    const app = AssistRoutes()
    const res = await app.request("http://localhost/inline-edit", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ instruction: "", selectedText: "" }),
    })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ text: "", error: "instruction and selection are required" })
  })

  test("a field of the wrong type returns 400 MRK-1009", async () => {
    const app = Server.compose(new Hono(), (base) => base.route("/assist", AssistRoutes()))
    const res = await app.request("http://localhost/assist/inline-edit", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ instruction: 1 }),
    })
    expect(res.status).toBe(400)
    expect(await res.json()).toMatchObject({ code: "MRK-1009" })
  })

  test("exposes only the two endpoints the desktop app uses: commit message and inline edit", async () => {
    const app = AssistRoutes()
    const spec = await generateSpecs(app, {
      documentation: {
        info: { title: "test", version: "1" },
        openapi: "3.1.1",
      },
    })
    const operations = Object.values(spec.paths ?? {}).flatMap((item) =>
      Object.values(item ?? {}).flatMap((op) =>
        op && typeof op === "object" && "operationId" in op ? [op.operationId] : [],
      ),
    )
    expect(operations.sort()).toEqual(["assist.commit.message", "assist.inline.edit"])
  })
})
