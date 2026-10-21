import { test, expect } from "vitest"
import { errorCode, NamedError, readableErrorText, unwrapErrorText } from "./error"
import z from "zod"

test("errorCode reads the code an error carries, or looks it up by name", () => {
  expect(errorCode({ name: "NotFoundError", code: "MRK-1011", data: {} })).toBe("MRK-1011")
  expect(errorCode({ name: "ProviderModelNotFoundError", data: {} })).toBe("MRK-2002")
  expect(errorCode({ name: "APIError", data: { statusCode: 429 } })).toBe("MRK-2004")
  expect(errorCode(Object.assign(new Error("x"), { code: "MRK-1007" }))).toBe("MRK-1007")
  expect(errorCode(Object.assign(new Error("x"), { code: "ENOENT" }))).toBeUndefined()
  expect(errorCode("boom")).toBeUndefined()
  expect(errorCode(undefined)).toBeUndefined()
})

test("NamedError carries its catalog code in toObject() and its schema", () => {
  const JsonError = NamedError.create("ConfigJsonError", z.object({ path: z.string() }))
  const object = new JsonError({ path: "/a.json" }).toObject()
  expect(object).toEqual({ name: "ConfigJsonError", code: "MRK-3001", data: { path: "/a.json" } })
  expect(JsonError.Schema.parse(object)).toEqual(object)
})

test("provider API errors get their code from the HTTP status", () => {
  const APIError = NamedError.create("APIError", z.object({ message: z.string(), statusCode: z.number().optional() }))
  expect(new APIError({ message: "slow down", statusCode: 429 }).toObject().code).toBe("MRK-2004")
})

test("unwrapErrorText: extracts errorMessage from gateway JSON", () => {
  expect(unwrapErrorText('{"errorCode":"FORBIDDEN","errorMessage":"api key invalid","state":"Error"}')).toBe(
    "api key invalid",
  )
  expect(unwrapErrorText('{"error":{"type":"RateLimit","message":"too many"}}')).toBe("RateLimit: too many")
})

test("readableErrorText: handles a retry { message } wrapper and a top-level gateway object", () => {
  expect(readableErrorText({ message: "Unable to connect" })).toBe("Unable to connect")
  expect(readableErrorText({ errorCode: "FORBIDDEN", errorMessage: "api key invalid", state: "Error" })).toBe(
    "api key invalid",
  )
  expect(readableErrorText({})).toBe("")
  expect(readableErrorText({})).not.toBe("[object Object]")
})

test("NamedError.isInstance: recognizes plain objects by name; rejects null and non-objects", () => {
  const Failed = NamedError.create("SomethingFailed", z.object({ name: z.string() }))
  expect(Failed.isInstance(new Failed({ name: "a" }))).toBe(true)
  expect(Failed.isInstance({ name: "SomethingFailed", data: { name: "a" } })).toBe(true)
  expect(Failed.isInstance(null)).toBe(false)
  expect(Failed.isInstance("SomethingFailed")).toBe(false)
})
