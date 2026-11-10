import { writeFile } from "node:fs/promises"
import path from "node:path"
import { render } from "solid-js/web"
import { afterAll, beforeAll, expect, test } from "vitest"
import { EngineEventSchema, type GroupGroup } from "@merakcode/sdk"
import { engineFixture } from "../../test/engine"
import { cloudFixture } from "../../test/cloud"
import { groups, groupView, loadGroups, localHuman } from "../../state/groups"
import { client } from "../../state/client"
import { setLocale } from "../../i18n"
import { setState } from "../../state/store"
import { GroupCreate } from "./group-create"
import { Profiles } from "../settings/profiles"

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

test("creates a cloud group and folds its forwarded history through the shared group state", async () => {
  const cloud = await cloudFixture()
  const connection = await client()
  const host = document.createElement("div")
  document.body.append(host)
  let created: GroupGroup | undefined
  let dispose = () => {}
  try {
    await connection.cloud.login({ dev: true, endpoint: cloud.endpoint })
    dispose = render(
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
    // Product discovery may take ten seconds before process cleanup.
    await expect
      .poll(() => document.querySelector<HTMLInputElement>('input[aria-label="Cloud group"]')?.disabled, {
        timeout: 15000,
      })
      .toBe(false)
    document.querySelector<HTMLInputElement>('input[aria-label="Cloud group"]')!.click()
    await expect.poll(() => document.querySelector('input[aria-label="Select First remote worker"]')).not.toBeNull()
    document.querySelector<HTMLInputElement>('input[aria-label="Select Second remote worker"]')!.click()
    expect(document.querySelector<HTMLInputElement>('input[aria-label="Select First remote worker"]')!.checked).toBe(
      false,
    )
    expect(document.querySelector<HTMLInputElement>('input[aria-label="Select Third remote worker"]')!.checked).toBe(
      false,
    )
    const create = [...document.querySelectorAll<HTMLButtonElement>("button")].find(
      (button) => button.textContent === "Create",
    )!
    expect(create.disabled).toBe(true)
    document
      .querySelector<HTMLInputElement>('input[aria-label="Allow this group\'s data to be sent to the cloud"]')!
      .click()
    await expect.poll(() => create.disabled).toBe(false)
    create.click()
    await expect.poll(() => created, { timeout: 10000 }).toBeDefined()
    expect(created?.kind).toBe("cloud")
    await loadGroups()
    expect(groups().some((group) => group.id === created?.id)).toBe(true)
    expect(groupView(created!.id)?.group?.kind).toBe("cloud")
    expect(
      groupView(created!.id)
        ?.members.filter((member) => member.id === "shared-worker")
        .map((member) => member.device),
    ).toEqual(["device-two"])
    const source = await connection.group.create({
      id: "",
      kind: "local",
      name: "Device source",
      project: { directory: engine.project },
      defaultLeader: "source-leader",
      profiles: [],
      members: [
        {
          id: "source-leader",
          group: "",
          name: "Leader",
          kind: "agent",
          agentRole: "leader",
          profile: "builtin-leader",
          status: "idle",
        },
        {
          id: "cloud-source-worker",
          group: "",
          name: "Device Worker",
          kind: "agent",
          agentRole: "worker",
          profile: "builtin-worker",
          owner: localHuman,
          status: "idle",
        },
      ],
    })
    expect(source.kind).toBe("local")
    dispose()
    dispose = render(() => <Profiles group={created!.id} kind="cloud" />, host)
    await expect.poll(() => host.querySelector('button[aria-label="Add Device Worker"]')).not.toBeNull()
    expect(host.querySelector('input[type="password"]')).toBeNull()
    expect(host.querySelector('button[aria-label="Copy Worker"]')).toBeNull()
    host.querySelector<HTMLButtonElement>('button[aria-label="Add Device Worker"]')!.click()
    await expect
      .poll(() =>
        groupView(created!.id)?.members.some((member) => member.id === "cloud-source-worker" && !!member.device),
      )
      .toBe(true)
    await connection.group.say({ group: created!.id, human: localHuman, text: "Cloud discussion" })
    await expect
      .poll(() =>
        groupView(created!.id)?.events.some(
          (event) => event.type === "human.said" && event.payload.text === "Cloud discussion",
        ),
      )
      .toBe(true)
    await expect
      .poll(() => groupView(created!.id)?.inbox.info.some((notice) => notice.text === "Cloud inbox notice"))
      .toBe(true)
    await connection.group.say({ group: created!.id, human: localHuman, text: "Approval pending" })
    await expect
      .poll(() => groupView(created!.id)?.inbox.todo.some((notice) => notice.request === "cloud-request"))
      .toBe(true)
    await connection.group.say({ group: created!.id, human: localHuman, text: "Approval answered" })
    await expect.poll(() => groupView(created!.id)?.inbox.todo).toEqual([])
    await connection.close()
    await loadGroups()
    expect(groupView(created!.id)?.inbox.todo).toEqual([])
    await (await client()).cloud.logout()
    await loadGroups()
    expect(groups().some((group) => group.id === created?.id)).toBe(false)
    expect(groupView(created!.id)).toBeUndefined()
  } finally {
    dispose()
    host.remove()
    await (await client()).cloud.logout()
    await cloud.close()
  }
}, 30_000)
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
    expect(document.querySelector<HTMLInputElement>('input[aria-label="Cloud group"]')?.disabled).toBe(true)
    expect(document.body.textContent).toContain("Sign in to create a cloud group")
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
