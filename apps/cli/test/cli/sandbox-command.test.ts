import { describe, expect, test } from "vitest"
import { lines } from "../../src/cli/cmd/sandbox"
import { I18n } from "../../src/cli/i18n"

describe("merak sandbox status text", () => {
  test("a sandbox that only needs setup says so in the user's language, without the engine's English reason", () => {
    const text = lines({ status: "unsupported", reason: "The sandbox needs a one-time setup", installable: true })
    expect(text).toEqual([I18n.t("cli.sandbox.notSetUp"), I18n.t("cli.sandbox.installable")])
  })

  test("a system without a sandbox shows the technical reason", () => {
    const text = lines({ status: "unsupported", reason: "sandbox-exec is not available on this system" })
    expect(text).toEqual([
      I18n.t("cli.sandbox.unavailable", { reason: "sandbox-exec is not available on this system" }),
    ])
  })

  test("limits of a running sandbox are listed", () => {
    const text = lines({ status: "on", backend: "landlock", degraded: ["udp-not-restricted"] })
    expect(text).toEqual([
      I18n.t("cli.sandbox.on", { backend: "landlock" }),
      I18n.t("cli.sandbox.degraded"),
      `  - ${I18n.t("cli.sandbox.limit.udp-not-restricted")}`,
    ])
  })
})
