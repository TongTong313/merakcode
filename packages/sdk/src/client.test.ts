import { expect, it } from "vitest"
import { connect } from "./client"

it.each([
  { endpoint: "https://127.0.0.1/", token: "test" },
  { endpoint: "ws://127.0.0.1/", token: "" },
])("rejects invalid connection options before opening a socket", async (options) => {
  await expect(connect(options)).rejects.toThrow()
})
