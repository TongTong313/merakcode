import { expect, test } from "vitest"
import { externalTarget } from "./external/target"

test("the external control target accepts an explicitly supplied HTTP port 80", () => {
  expect(externalTarget("http://example.com:80")).toEqual({ hostname: "example.com", port: 80 })
})

test.each([
  ["http://example.com:8080", 8080],
  ["http://example.com:80/control?probe=1#result", 80],
])("the external control target preserves the TCP port in %s", (endpoint, port) => {
  expect(externalTarget(endpoint)).toEqual({ hostname: "example.com", port })
})

test.each([undefined, "http://example.com", "http://example.com/path:80", "https://example.com:8080"])(
  "the external control target rejects missing or unsupported configuration: %s",
  (endpoint) => {
    expect(() => externalTarget(endpoint)).toThrow()
  },
)
