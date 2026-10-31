import { afterEach, describe, expect, test } from "vitest"
import { Hono } from "hono"
import z from "zod"
import { Server } from "@merakcode/engine/app/server/server"
import { validator } from "@merakcode/engine/app/server/validator"
import { Storage } from "@merakcode/engine/infra/storage/storage"
import { setLocalSecretForTest } from "@merakcode/engine/app/server/auth/local-secret"

const app = () =>
  Server.compose(new Hono(), (base) =>
    base
      .get("/__test/missing", () => {
        throw new Storage.NotFoundError({ message: "session ses_1 not found" })
      })
      .get("/__test/boom", () => {
        throw new Error("boom: secret internals")
      })
      .get("/__test/valid", validator("query", z.object({ count: z.coerce.number() })), (c) => c.json(true)),
  )

afterEach(() => setLocalSecretForTest(undefined))

describe("error responses", () => {
  test("named errors answer with their status, catalog code, message and request id", async () => {
    const response = await app().request("/__test/missing")
    expect(response.status).toBe(404)
    const body = await response.json()
    expect(body).toMatchObject({ name: "NotFoundError", code: "MRK-1011", message: "session ses_1 not found" })
    expect(body.requestID).toBe(response.headers.get("x-request-id"))
  })

  test("unexpected errors answer MRK-9000 without leaking the message or stack", async () => {
    const response = await app().request("/__test/boom")
    expect(response.status).toBe(500)
    const body = await response.json()
    expect(body.code).toBe("MRK-9000")
    expect(body.requestID).toBe(response.headers.get("x-request-id"))
    const text = JSON.stringify(body)
    expect(text).not.toContain("secret internals")
    expect(text).not.toContain("    at ")
  })

  test("invalid input answers MRK-1009 and says which field is wrong", async () => {
    const response = await app().request("/__test/valid?count=abc")
    expect(response.status).toBe(400)
    const body = await response.json()
    expect(body).toMatchObject({ name: "BadRequestError", code: "MRK-1009" })
    expect(body.message).toContain("count")
    expect(body.requestID).toBe(response.headers.get("x-request-id"))
  })

  test("a wrong password answers JSON with MRK-1005", async () => {
    setLocalSecretForTest("right")
    const response = await app().request("/__test/missing", {
      headers: { authorization: `Basic ${btoa("merakcode:wrong")}` },
    })
    expect(response.status).toBe(401)
    expect(await response.json()).toMatchObject({ code: "MRK-1005" })
  })
})
