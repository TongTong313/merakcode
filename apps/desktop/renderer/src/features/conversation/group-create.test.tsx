import { writeFile } from "node:fs/promises"
import path from "node:path"
import { render } from "solid-js/web"
import { afterAll, beforeAll, expect, test } from "vitest"
import { EngineEventSchema, type GroupGroup } from "@merakcode/sdk"
import { engineFixture } from "../../test/engine"
import { client } from "../../state/client"
import { setLocale } from "../../i18n"
import { setState } from "../../state/store"
import { GroupCreate } from "./group-create"

let engine: Awaited<ReturnType<typeof engineFixture>>
beforeAll(async () => {
  engine = await engineFixture()
  location.href = engine.url
  setLocale("en")
  await writeFile(path.join(engine.project, "README.md"), "# Group fixture\n")
  await engine.git("add", "README.md")
  await engine.git("commit", "-m", "Fixture")
  setState("config", { providers: { fake: { hasKey: true } } })
  setState("models", [
    {
      provider: "fake",
      id: "fixture",
      window: 32000,
      maxOutput: 4096,
      source: "builtin",
      thinking: [],
      caps: { tools: true, vision: false, pdf: false },
      price: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    },
  ])
})
afterAll(async () => {
  try {
    await (await client()).close()
  } finally {
    await engine.close()
  }
})

test("creates a local group from default profiles and adds the selected worker", async () => {
  let created: GroupGroup | undefined
  const host = document.createElement("div")
  document.body.appendChild(host)
  const dispose = render(
    () => (
      <GroupCreate
        directory={engine.project}
        open
        onClose={() => {}}
        onCreated={(group) => {
          created = group
        }}
      />
    ),
    host,
  )
  try {
    await expect
      .poll(() => document.querySelector('input[aria-label="Select Worker"]'), { timeout: 10000 })
      .not.toBeNull()
    const name = document.querySelector<HTMLInputElement>('input[aria-label="Group name"]')!
    name.value = "Documentation team"
    name.dispatchEvent(new InputEvent("input", { bubbles: true }))
    document.querySelector<HTMLInputElement>('input[aria-label="Select Worker"]')!.click()
    const create = [...document.querySelectorAll<HTMLButtonElement>("button")].find(
      (button) => button.textContent === "Create",
    )!
    await expect.poll(() => create.disabled).toBe(false)
    create.click()
    expect(name.disabled).toBe(true)
    expect(document.querySelector<HTMLInputElement>('input[aria-label="Project directory"]')!.disabled).toBe(true)
    await expect.poll(() => created, { timeout: 10000 }).toBeDefined()
    expect(created?.kind).toBe("local")
    expect(created?.project.directory).toBe(engine.project)
    const facts = (await (await client()).events.read({ stream: `group:${created!.id}`, from: 1 }))?.map((event) =>
      EngineEventSchema.parse(event),
    )
    const initial = facts?.find((event) => event.type === "group.created")
    expect(initial?.payload.members?.some((member) => member.kind === "human" && member.role === "owner")).toBe(true)
    expect(facts?.some((event) => event.type === "member.added" && event.payload.agentRole === "worker")).toBe(true)
  } finally {
    dispose()
    host.remove()
  }
})
