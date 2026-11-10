import { createServer } from "node:http"
import { render } from "solid-js/web"
import { expect, test } from "vitest"
import { engineFixture } from "../../test/engine"
import { client } from "../../state/client"
import { setLocale } from "../../i18n"
import { setUi } from "../../state/ui"
import { Settings } from "./settings"

test("signs into the development cloud without exposing its token and signs out", async () => {
  const cloud = createServer((request, response) => {
    if (request.url !== "/auth/dev" || request.method !== "POST") {
      response.writeHead(503).end()
      return
    }
    response.setHeader("Content-Type", "application/json")
    response.end(JSON.stringify({ account: "development-account", token: "private-cloud-token" }))
  })
  await new Promise<void>((resolve) => cloud.listen(0, "127.0.0.1", resolve))
  const address = cloud.address()
  if (!address || typeof address === "string") throw new Error("Cloud fixture did not listen")
  const engine = await engineFixture()
  const host = document.createElement("div")
  document.body.append(host)
  let dispose = () => {}
  try {
    location.href = engine.url
    setLocale("en")
    setUi("settings", "cloud")
    const connection = await client()
    dispose = render(() => <Settings />, host)
    await expect.poll(() => host.querySelector('input[aria-label="Cloud server"]')).not.toBeNull()
    const endpoint = host.querySelector<HTMLInputElement>('input[aria-label="Cloud server"]')!
    endpoint.value = `ws://127.0.0.1:${address.port}`
    endpoint.dispatchEvent(new InputEvent("input", { bubbles: true }))
    ;[...host.querySelectorAll<HTMLButtonElement>("button")]
      .find((button) => button.textContent === "Sign in to development cloud")!
      .click()
    await expect.poll(() => host.textContent, { timeout: 15000 }).toContain("development-account")
    expect(host.textContent).toContain("Offline")
    expect(host.innerHTML).not.toContain("private-cloud-token")
    expect(await connection.cloud.status()).toMatchObject({ account: "development-account", online: false })
    const signOut = [...host.querySelectorAll<HTMLButtonElement>("button")].find(
      (button) => button.textContent === "Sign out",
    )!
    await expect.poll(() => signOut.disabled).toBe(false)
    signOut.click()
    await expect.poll(async () => (await connection.cloud.status()).account).toBeUndefined()
    await expect.poll(() => host.textContent).toContain("Not signed in")
  } finally {
    dispose()
    host.remove()
    const connection = await client()
    await connection.cloud?.logout()
    await connection.close()
    await engine.close()
    await new Promise<void>((resolve) => cloud.close(() => resolve()))
  }
}, 30_000)
