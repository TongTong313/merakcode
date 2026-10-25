import { expect, test } from "vitest"
import { providerChanged, type SeenFailures } from "./catalog-refresh"

const none: SeenFailures = {}

const failed = (code: string, message = "catalog 500 http://example") => ({
  reason: "refresh-failed" as const,
  providerID: "deepseek",
  error: {
    name: "CatalogRefreshError" as const,
    code,
    data: { providerID: "deepseek", message, statusCode: code === "MRK-2001" ? 401 : 500 },
  },
})

test("a refreshed provider is reloaded and its previous failure can be shown again", () => {
  const first = providerChanged(none, failed("MRK-2010"))
  expect(first.reload).toBe(true)
  expect(first.toast).toEqual({ providerID: "deepseek", code: "MRK-2010", message: "catalog 500 http://example" })

  const again = providerChanged(first.seen, failed("MRK-2010"))
  expect(again.toast).toBeUndefined()
  expect(again.reload).toBe(true)

  const refreshed = providerChanged(again.seen, { reason: "refreshed", providerID: "deepseek" })
  expect(refreshed.toast).toBeUndefined()
  expect(refreshed.reload).toBe(true)

  const after = providerChanged(refreshed.seen, failed("MRK-2010"))
  expect(after.toast?.code).toBe("MRK-2010")
})

test("a different failure for the same provider is shown, and another provider is separate", () => {
  const first = providerChanged(none, failed("MRK-2010"))
  const rejected = providerChanged(first.seen, failed("MRK-2001", "catalog 401 http://example"))
  expect(rejected.toast).toMatchObject({ code: "MRK-2001" })

  const other = providerChanged(rejected.seen, {
    ...failed("MRK-2010"),
    providerID: "openai",
    error: { ...failed("MRK-2010").error, data: { message: "catalog 500 http://example" } },
  })
  expect(other.toast).toMatchObject({ providerID: "openai", code: "MRK-2010" })
})

test("connecting or disconnecting a provider does not reload the catalog from this event", () => {
  expect(providerChanged(none, { reason: "connected", providerID: "deepseek" }).reload).toBe(false)
  expect(providerChanged(none, { reason: "disconnected", providerID: "deepseek" }).reload).toBe(false)
})
