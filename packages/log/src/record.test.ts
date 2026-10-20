import { expect, test } from "vitest"
import { buildRecord, sanitize } from "./record"
import { failure } from "./failure"

test("redacts secrets and bounds cyclic diagnostic data", () => {
  const input: Record<string, unknown> = { access_token: "secret", authorization: "Bearer abc", nested: {} }
  input.nested = input
  expect(sanitize(input)).toEqual({ access_token: "<redacted>", authorization: "<redacted>", nested: "<circular>" })
})

test("redacts embedded credentials, URL credentials and model payloads", () => {
  const value = JSON.stringify(
    sanitize({
      diagnostic: "token=secret1 --token secret2 https://u:secret3@example.com/test?key=secret4 Bearer secret5",
      prompt: "private-prompt",
      responseBody: "private-response",
      messages: ["private-message"],
    }),
  )
  for (const secret of [
    "secret1",
    "secret2",
    "secret3",
    "secret4",
    "secret5",
    "private-prompt",
    "private-response",
    "private-message",
  ])
    expect(value).not.toContain(secret)
})

test("hostile values cannot crash sanitization", () => {
  const error = new Error("failed")
  error.cause = error
  expect(() => JSON.stringify(sanitize(error))).not.toThrow()
  expect(
    sanitize({
      get fail() {
        throw new Error("getter")
      },
    }),
  ).toBe("<unserializable>")
  expect(sanitize(new Date(NaN))).toBe("<invalid-date>")
})

test("failure categories distinguish authentication, network, upstream and unknown", () => {
  expect(failure({ statusCode: 401 }).category).toBe("authentication_or_permission")
  expect(failure({ cause: { code: "ENOTFOUND" } }).category).toBe("network_or_tls")
  expect(failure({ statusCode: 503 }).category).toBe("upstream_service")
  expect(failure({ name: "RequestTimeoutError" }).category).toBe("timeout")
  expect(failure(new Error("bad"), true).category).toBe("cancelled")
  expect(failure(new Error("bad")).category).toBe("unknown")
})

test("builds a stable structured record", () => {
  expect(
    buildRecord({
      level: "INFO",
      component: "cli",
      service: "startup",
      message: "ready",
      runId: "run-1",
      sequence: 2,
      pid: 3,
      timestamp: new Date("2026-09-02T00:00:00.000Z"),
    }),
  ).toEqual({
    schema: "merakcode.log.v1",
    timestamp: "2026-09-02T00:00:00.000Z",
    level: "INFO",
    component: "cli",
    service: "startup",
    message: "ready",
    run_id: "run-1",
    sequence: 2,
    pid: 3,
  })
})
