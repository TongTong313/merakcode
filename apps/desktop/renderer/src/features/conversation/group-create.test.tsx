import { writeFile } from "node:fs/promises"
import path from "node:path"
import { render } from "solid-js/web"
import { afterAll, beforeAll, expect, test } from "vitest"
import { EngineEventSchema, type GroupGroup } from "@merakcode/sdk"
import { engineFixture } from "../../test/engine"
import { cloudFixture } from "../../test/cloud"
import { groups, groupsLoaded, groupView, loadGroups, localHuman } from "../../state/groups"
import { client } from "../../state/client"
import { setLocale } from "../../i18n"
import { setState } from "../../state/store"
import { GroupCreate } from "./group-create"
import { CloudMembers } from "../settings/cloud-members"

/** The group kind is a segmented control and the cloud consent a switch, not native inputs */
const cloudKind = () =>
  [...document.querySelectorAll<HTMLButtonElement>('[role="radio"]')].find((item) => item.textContent === "Cloud group")
const consent = () =>
  [...document.querySelectorAll<HTMLButtonElement>('[role="switch"]')].find(
    (item) => item.textContent === "Allow this group's data to be sent to the cloud",
  )

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
    await expect.poll(() => cloudKind()?.getAttribute("aria-disabled"), { timeout: 15000 }).toBeNull()
    cloudKind()!.click()
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
    consent()!.click()
    await expect.poll(() => create.disabled).toBe(false)
    create.click()
    await expect.poll(() => created, { timeout: 10000 }).toBeDefined()
    expect(created?.kind).toBe("cloud")
    await loadGroups()
    await groupsLoaded()
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
      leader: "source-leader",
      members: [
        {
          id: "source-leader",
          group: "",
          name: "Leader",
          kind: "agent",
          agentRole: "leader",
          agent: "builtin-merakcode",
          status: "idle",
        },
        {
          id: "cloud-source-worker",
          group: "",
          name: "Device Worker",
          kind: "agent",
          agentRole: "worker",
          agent: "builtin-merakcode",
          owner: localHuman,
          status: "idle",
        },
      ],
    })
    expect(source.kind).toBe("local")
    dispose()
    dispose = render(() => <CloudMembers group={created!.id} />, host)
    await expect.poll(() => host.querySelector('button[aria-label="Add Device Worker"]')).not.toBeNull()
    expect(host.querySelector('input[type="password"]')).toBeNull()
    host.querySelector<HTMLButtonElement>('button[aria-label="Add Device Worker"]')!.click()
    await expect
      .poll(() =>
        groupView(created!.id)?.members.some((member) => member.id === "cloud-source-worker" && !!member.device),
      )
      .toBe(true)
    await connection.group.say({ group: created!.id, text: "Cloud discussion" })
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
    await connection.group.say({ group: created!.id, text: "Approval pending" })
    await expect
      .poll(() => groupView(created!.id)?.inbox.todo.some((notice) => notice.request === "cloud-request"))
      .toBe(true)
    await connection.group.say({ group: created!.id, text: "Approval answered" })
    await expect.poll(() => groupView(created!.id)?.inbox.todo).toEqual([])
    await connection.close()
    await loadGroups()
    await groupsLoaded()
    expect(groupView(created!.id)?.inbox.todo).toEqual([])
    await (await client()).cloud.logout()
    await loadGroups()
    await groupsLoaded()
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
  const before = (await (await client()).agent.list({}))!.length
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
      .poll(() => document.querySelector('input[aria-label="Select MerakCode"]'), { timeout: 10000 })
      .not.toBeNull()
    expect(cloudKind()?.getAttribute("aria-disabled")).toBe("true")
    expect(document.body.textContent).toContain("Sign in to create a cloud group")
    const name = document.querySelector<HTMLInputElement>('input[aria-label="Group name"]')!
    name.value = "Documentation team"
    name.dispatchEvent(new InputEvent("input", { bubbles: true }))
    document.querySelector<HTMLInputElement>('input[aria-label="Select MerakCode"]')!.click()
    const create = [...document.querySelectorAll<HTMLButtonElement>("button")].find(
      (button) => button.textContent === "Create",
    )!
    await expect.poll(() => create.disabled).toBe(false)
    create.click()
    expect(name.disabled).toBe(true)
    expect(document.querySelector<HTMLButtonElement>('button[aria-label="Workspace"]')!.disabled).toBe(true)
    await expect.poll(() => created, { timeout: 10000 }).toBeDefined()
    expect(created?.kind).toBe("local")
    expect(created?.project.directory).toBe(engine.project)
    const facts = (await (await client()).events.read({ stream: `group:${created!.id}`, from: 1 }))?.map((event) =>
      EngineEventSchema.parse(event),
    )
    const initial = facts?.find((event) => event.type === "group.created")
    expect(initial?.payload.members?.some((member) => member.kind === "human" && member.role === "owner")).toBe(true)
    expect(facts?.some((event) => event.type === "member.added" && event.payload.agentRole === "worker")).toBe(true)
    expect((await (await client()).agent.list({}))!.length).toBe(before)
  } finally {
    dispose()
    host.remove()
  }
})

const opened = () => document.querySelector<HTMLElement>('[role="dialog"]:not([data-closed])')!
const pick = async (label: string) => {
  const trigger = () => opened().querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)!
  await expect.poll(() => trigger()?.textContent, { timeout: 10000 }).toBeTruthy()
  trigger().dispatchEvent(new PointerEvent("pointerdown", { button: 0, bubbles: true, pointerType: "mouse" }))
  await expect.poll(() => document.querySelectorAll('[role="option"]').length, { timeout: 10000 }).toBeGreaterThan(0)
  return [...document.querySelectorAll<HTMLElement>('[role="option"]')]
}

test("any agent can be a member, the Leader list holds the agents that can lead, and the dialog has no model choice", async () => {
  const connection = await client()
  await connection.agent.save({
    agent: {
      id: "",
      name: "Plain agent",
      summary: "",
      duties: "",
      toolPool: "worker.default",
      model: { provider: "fake", model: "fixture" },
    },
  })
  await connection.agent.save({
    agent: {
      id: "",
      name: "Command runner",
      summary: "",
      duties: "",
      toolPool: "worker.default",
      model: { provider: "", model: "" },
      product: { kind: "command", binary: "node" },
    },
  })
  await connection.agent.save({
    agent: {
      id: "",
      name: "Claude lead",
      summary: "",
      duties: "",
      toolPool: "worker.default",
      model: { provider: "", model: "" },
      product: { kind: "claude-code", binary: "claude" },
    },
  })
  const host = document.createElement("div")
  document.body.appendChild(host)
  const dispose = render(
    () => <GroupCreate directory={engine.project} open onClose={() => {}} onCreated={() => {}} />,
    host,
  )
  try {
    await expect
      .poll(() => opened()?.querySelector('input[aria-label="Select Command runner"]'), { timeout: 10000 })
      .not.toBeNull()
    for (const name of ["MerakCode", "Plain agent", "Claude lead"])
      expect(opened().querySelector(`input[aria-label="Select ${name}"]`)).not.toBeNull()
    expect(opened().querySelector('button[aria-label^="Configure model"]')).toBeNull()
    const options = (await pick("Leader")).map((option) => option.textContent ?? "")
    expect(options.some((label) => label.includes("Command runner"))).toBe(false)
    for (const name of ["Plain agent", "Claude lead"]) expect(options.some((label) => label.includes(name))).toBe(true)
    expect(options.some((label) => label.startsWith("MerakCode"))).toBe(true)
  } finally {
    dispose()
    host.remove()
    document.querySelectorAll(".dialog-positioner").forEach((node) => node.remove())
  }
})

test("creating groups saves and changes no agent, and the Leader runs on the model set on its agent", async () => {
  const connection = await client()
  const lead = await connection.agent.save({
    agent: {
      id: "",
      name: "Chosen model lead",
      summary: "Leads on its own model.",
      duties: "",
      toolPool: "worker.default",
      model: { provider: "fake", model: "fixture" },
    },
  })
  const snapshot = async () => JSON.stringify(await connection.agent.list({}))
  const before = await snapshot()
  const created: GroupGroup[] = []
  const host = document.createElement("div")
  document.body.appendChild(host)
  const dispose = render(
    () => <GroupCreate directory={engine.project} open onClose={() => {}} onCreated={(group) => created.push(group)} />,
    host,
  )
  try {
    await expect
      .poll(() => opened()?.querySelector('input[aria-label="Select MerakCode"]'), { timeout: 10000 })
      .not.toBeNull()
    ;(await pick("Leader")).find((option) => option.textContent?.includes("Chosen model lead"))!.click()
    const create = () =>
      [...opened().querySelectorAll<HTMLButtonElement>("button")].find((item) => item.textContent === "Create")!
    await expect.poll(() => create().disabled, { timeout: 15000 }).toBe(false)
    create().click()
    await expect.poll(() => created.length, { timeout: 15000 }).toBe(1)
    expect(await snapshot()).toBe(before)
    const group = created[0]!
    await connection.group.say({ group: group.id, text: "Start now" })
    await expect
      .poll(
        async () => {
          const facts = await connection.events.find({ scope: { group: group.id }, types: ["session.created"] })
          const event = facts
            ?.map((fact) => EngineEventSchema.parse(fact))
            .find((item) => item.type === "session.created")
          return event?.type === "session.created"
            ? [event.payload.config.provider, event.payload.config.model]
            : undefined
        },
        { timeout: 15000 },
      )
      .toEqual(["fake", "fixture"])
    const members = (await connection.events.find({ scope: { group: group.id }, types: ["group.created"] }))!.map(
      (fact) => EngineEventSchema.parse(fact),
    )
    const first = members[0]!
    if (first.type !== "group.created") throw new Error("group.created is missing")
    expect(first.payload.members?.find((member) => member.agentRole === "leader")?.agent).toBe(lead.id)
    // The Leader seat is named after its agent, not after the person who made the group
    expect(first.payload.members?.find((member) => member.agentRole === "leader")?.name).toBe("Chosen-model-lead")
  } finally {
    dispose()
    host.remove()
    document.querySelectorAll(".dialog-positioner").forEach((node) => node.remove())
  }
})
