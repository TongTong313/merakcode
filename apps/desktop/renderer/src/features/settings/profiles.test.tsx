import { render } from "solid-js/web"
import { execFile } from "node:child_process"
import path from "node:path"
import { promisify } from "node:util"
import { afterAll, beforeAll, expect, test } from "vitest"
import { engineFixture } from "../../test/engine"
import { client } from "../../state/client"
import { localHuman } from "../../state/groups"
import { setLocale } from "../../i18n"
import { Profiles } from "./profiles"

let engine: Awaited<ReturnType<typeof engineFixture>>
let binary: string
beforeAll(async () => {
  engine = await engineFixture()
  binary = path.join(path.dirname(engine.project), process.platform === "win32" ? "fakeclaude.exe" : "fakeclaude")
  await promisify(execFile)("go", ["build", "-o", binary, "./engine/worker/claudecode/testdata/fakeclaude"], {
    cwd: path.resolve(import.meta.dirname, "../../../../../../merak"),
    windowsHide: true,
  })
  location.href = engine.url
  setLocale("en")
})

test("saves a custom product and checks its real adapter connection", async () => {
  const host = document.createElement("div")
  document.body.appendChild(host)
  const dispose = render(() => <Profiles />, host)
  const input = (label: string, value: string) => {
    const field = host.querySelector<HTMLInputElement | HTMLTextAreaElement>(`[aria-label="${label}"]`)!
    field.value = value
    field.dispatchEvent(new InputEvent("input", { bubbles: true }))
  }
  try {
    await expect.poll(() => host.querySelector('button[aria-label="Copy Worker"]')).not.toBeNull()
    host.querySelector<HTMLButtonElement>('button[aria-label="Copy Worker"]')!.click()
    input("Profile name", "CLI tester")
    const product = host.querySelector<HTMLSelectElement>('select[aria-label="Product"]')!
    expect(product).not.toBeNull()
    product.value = "claude-code"
    product.dispatchEvent(new Event("change", { bubbles: true }))
    input("Command", binary)
    input("Arguments (one per line)", "--history")
    input("Product model", "fixture-model")
    input("Environment variables (NAME=value)", "FIXTURE_VALUE=example")
    input("Allowed network hosts (one per line)", "api.example.com\n*.models.example.com:443")
    host.querySelector<HTMLButtonElement>('button[aria-label="Test connection"]')!.click()
    await expect.poll(() => host.textContent, { timeout: 10000 }).toContain("Connection verified")
    host.querySelector<HTMLButtonElement>('button[aria-label="Save profile"]')!.click()
    await expect
      .poll(
        async () => (await (await client()).agent.list({}))?.find((profile) => profile.name === "CLI tester")?.product,
      )
      .toEqual({
        kind: "claude-code",
        binary,
        args: ["--history"],
        model: "fixture-model",
        env: { FIXTURE_VALUE: "" },
      })
    expect((await (await client()).agent.list({}))?.find((profile) => profile.name === "CLI tester")?.network).toEqual([
      "api.example.com",
      "*.models.example.com:443",
    ])
  } finally {
    dispose()
    host.remove()
  }
})
afterAll(async () => {
  try {
    await (await client()).close()
  } finally {
    await engine.close()
  }
})

test("copies a default profile, edits its duties and registers it in the group", async () => {
  const connection = await client()
  const group = await connection.group.create({
    id: "",
    kind: "local",
    name: "Profiles",
    project: { directory: engine.project + "/.." },
    leader: "leader",
    members: [
      { id: localHuman, group: "", kind: "human", name: "You", role: "owner", status: "idle" },
      {
        id: "leader",
        group: "",
        kind: "agent",
        name: "Leader",
        agentRole: "leader",
        agent: "builtin-leader",
        owner: localHuman,
        status: "idle",
      },
    ],
  })
  const host = document.createElement("div")
  document.body.appendChild(host)
  const dispose = render(() => <Profiles group={group.id} />, host)
  const press = (label: string) => host.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)!.click()
  const input = (label: string, value: string) => {
    const field = host.querySelector<HTMLInputElement | HTMLTextAreaElement>(`[aria-label="${label}"]`)!
    field.value = value
    field.dispatchEvent(new InputEvent("input", { bubbles: true }))
  }
  try {
    await expect.poll(() => host.querySelector('button[aria-label="Copy Worker"]')).not.toBeNull()
    press("Copy Worker")
    input("Profile name", "Audit")
    host
      .querySelector<HTMLButtonElement>('button[aria-label="Permission level"]')!
      .dispatchEvent(new PointerEvent("pointerdown", { button: 0, bubbles: true, pointerType: "mouse" }))
    ;[...document.querySelectorAll<HTMLElement>('[role="option"]')]
      .find((option) => option.textContent?.includes("Full takeover"))!
      .click()
    ;[...document.querySelectorAll<HTMLButtonElement>('[role="dialog"] button')]
      .find((button) => button.textContent === "Enable full takeover")!
      .click()
    input("Duties", "Review Go changes and verify regression tests.")
    input("Provider", "fake")
    input("Model", "fixture")
    press("Save profile")
    await expect.poll(() => host.querySelector('button[aria-label="Add Audit"]')).not.toBeNull()
    expect((await connection.agent.list({}))?.find((profile) => profile.name === "Audit")?.mode).toBe("takeover")
    press("Add Audit")
    await expect
      .poll(async () =>
        (await connection.group.state({ group: group.id })).members?.some((member) => member.name === "Audit"),
      )
      .toBe(true)
    press("Edit Audit")
    input("Duties", "Review Go and TypeScript changes.")
    press("Save profile")
    await expect
      .poll(async () => (await connection.agent.list({}))?.find((profile) => profile.name === "Audit")?.duties)
      .toBe("Review Go and TypeScript changes.")
  } finally {
    dispose()
    host.remove()
  }
})
