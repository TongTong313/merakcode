import { connect } from "@merakcode/sdk"
import { render } from "solid-js/web"
import { expect, test } from "vitest"
import { engineFixture } from "../../test/engine"
import { client } from "../../state/client"
import { localHuman } from "../../state/groups"
import { setLocale } from "../../i18n"
import { Profiles } from "./profiles"

test("connects another engine and registers a selected remote worker without saving its token in the profile", async () => {
  const [first, second] = await Promise.all([engineFixture(), engineFixture()])
  const other = await connect({ endpoint: second.url.replace("http:", "ws:") })
  location.href = first.url
  setLocale("en")
  const connection = await client()
  const makeGroup = (target: typeof connection, directory: string, worker: boolean) =>
    target.group.create({
      id: "",
      name: "Remote fixture",
      kind: "local",
      project: { directory },
      leader: "leader",
      members: [
        { id: localHuman, group: "", kind: "human", name: "You", role: "owner", status: "idle" },
        {
          id: "leader",
          group: "",
          kind: "agent",
          name: worker ? "Remote Coordinator" : "Leader",
          agentRole: "leader",
          agent: "builtin-leader",
          status: "idle",
        },
        ...(worker
          ? [
              {
                id: "worker",
                group: "",
                kind: "agent",
                name: "Remote Worker",
                agentRole: "worker",
                agent: "builtin-worker",
                status: "idle",
              },
            ]
          : []),
      ],
    })
  const host = document.createElement("div")
  document.body.append(host)
  let dispose = () => {}
  try {
    const group = await makeGroup(connection, first.project + "/..", false)
    await makeGroup(other, second.project + "/..", true)
    dispose = render(() => <Profiles group={group.id} />, host)
    await expect.poll(() => host.querySelector('input[aria-label="Remote server"]')).not.toBeNull()
    const input = (label: string, value: string) => {
      const field = host.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`)!
      field.value = value
      field.dispatchEvent(new InputEvent("input", { bubbles: true }))
    }
    input("Remote server", second.endpoint)
    input("Remote token", second.token)
    ;[...host.querySelectorAll<HTMLButtonElement>("button")]
      .find((button) => button.textContent === "Connect remote engine")!
      .click()
    await expect
      .poll(() => host.querySelector('button[aria-label="Add Remote Worker"]'), { timeout: 15000 })
      .not.toBeNull()
    expect(host.querySelector<HTMLInputElement>('input[aria-label="Remote token"]')!.value).toBe("")
    expect(host.querySelector('button[aria-label="Add Remote Coordinator"]')).not.toBeNull()
    expect(host.textContent).toContain("Can only take tasks that do not change code")
    host.querySelector<HTMLButtonElement>('button[aria-label="Add Remote Worker"]')!.click()
    await expect
      .poll(async () =>
        (await connection.group.state({ group: group.id })).members?.some((member) => member.name === "Remote Worker"),
      )
      .toBe(true)
    const profiles = await connection.agent.list({})
    expect(profiles?.find((profile) => profile.name === "Remote Worker")?.product?.kind).toBe("remote")
    expect(JSON.stringify(profiles)).not.toContain(second.token)
  } finally {
    dispose()
    host.remove()
    await connection.close()
    await other.close()
    await Promise.all([first.close(), second.close()])
  }
}, 30_000)
