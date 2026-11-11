import { Route, Router } from "@solidjs/router"
import { render } from "solid-js/web"
import { expect, test } from "vitest"
import { engineFixture } from "../../test/engine"
import { client } from "../../state/client"
import { groups, groupView, loadGroups, localHuman } from "../../state/groups"
import { setLocale } from "../../i18n"
import { GroupConversation } from "../conversation/group-page"

test("owners change group initiative and receive later settings updates", async () => {
  const engine = await engineFixture()
  const host = document.createElement("div")
  document.body.append(host)
  let dispose = () => {}
  try {
    await engine.git("commit", "--allow-empty", "-m", "Fixture")
    location.href = engine.url
    setLocale("en")
    const connection = await client()
    const profiles = await connection.profile.list({})
    const leader = await connection.profile.save({
      profile: { ...profiles![0]!, id: "", model: { provider: "fake", model: "fixture" } },
    })
    const group = await connection.group.create({
      id: "",
      kind: "local",
      name: "Settings",
      project: { directory: engine.project },
      defaultLeader: "leader",
      profiles: [],
      settings: { initiative: "normal", planNeedsApproval: true },
      members: [
        { id: localHuman, group: "", kind: "human", name: "Owner", role: "owner", status: "idle" },
        {
          id: "leader",
          group: "",
          kind: "agent",
          name: "Leader",
          agentRole: "leader",
          profile: leader.id,
          status: "idle",
        },
      ],
    })
    await loadGroups()
    dispose = render(
      () => (
        <Router>
          <Route path="/" component={() => <GroupConversation id={group.id} directory={engine.project} />} />
        </Router>
      ),
      host,
    )
    const selector = () => host.querySelector<HTMLSelectElement>('select[aria-label="Initiative"]')
    await expect.poll(() => selector()?.value).toBe("normal")
    const limit = (label: string) => host.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`)
    expect(limit("Thread turns per minute")?.value).toBe("6")
    expect(limit("Group turns per minute")?.value).toBe("30")
    limit("Thread turns per minute")!.value = "9"
    limit("Thread turns per minute")!.dispatchEvent(new Event("change", { bubbles: true }))
    await expect.poll(() => groupView(group.id)?.group?.settings?.turnsPerMinute?.thread).toBe(9)
    expect(groupView(group.id)?.group?.settings?.planNeedsApproval).toBe(true)
    await connection.group.say({ group: group.id, text: "Report current status", to: ["leader"] })
    await expect
      .poll(() => groupView(group.id)?.events.some((event) => event.type === "turn.finished"), { timeout: 10000 })
      .toBe(true)
    await expect.poll(() => groupView(group.id)?.events.some((event) => event.type === "session.budget")).toBe(true)
    selector()!.value = "passive"
    selector()!.dispatchEvent(new Event("change", { bubbles: true }))
    await expect.poll(() => groupView(group.id)?.group?.settings?.initiative).toBe("passive")
    expect(groupView(group.id)?.group?.settings?.planNeedsApproval).toBe(true)
    await connection.group.update({
      group: group.id,
      settings: { ...group.settings, initiative: "eager" },
    })
    await expect.poll(() => selector()?.value).toBe("eager")
    await expect.poll(() => groups().find((item) => item.id === group.id)?.settings?.initiative).toBe("eager")
    await loadGroups()
    expect(groups().find((item) => item.id === group.id)?.settings?.initiative).toBe("eager")
  } finally {
    dispose()
    host.remove()
    await (await client()).close()
    await engine.close()
  }
}, 30_000)
