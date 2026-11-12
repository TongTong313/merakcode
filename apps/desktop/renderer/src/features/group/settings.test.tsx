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
    const profiles = await connection.agent.list({})
    const leader = await connection.agent.save({
      agent: { ...profiles![0]!, id: "", model: { provider: "fake", model: "fixture" } },
    })
    const group = await connection.group.create({
      id: "",
      kind: "local",
      name: "Settings",
      project: { directory: engine.project },
      leader: "leader",
      settings: { initiative: "normal", planNeedsApproval: true },
      members: [
        { id: localHuman, group: "", kind: "human", name: "Owner", role: "owner", status: "idle" },
        {
          id: "leader",
          group: "",
          kind: "agent",
          name: "Leader",
          agentRole: "leader",
          agent: leader.id,
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
    const selector = () => host.querySelector<HTMLButtonElement>('button[aria-label="Initiative"]')
    await expect.poll(() => selector()?.textContent).toContain("Normal")
    expect(groupView(group.id)?.group?.settings?.planNeedsApproval).toBe(true)
    await connection.group.say({ group: group.id, text: "Report current status", to: ["leader"] })
    await expect
      .poll(() => groupView(group.id)?.events.some((event) => event.type === "turn.finished"), { timeout: 10000 })
      .toBe(true)
    await expect.poll(() => groupView(group.id)?.events.some((event) => event.type === "session.budget")).toBe(true)
    selector()!.dispatchEvent(new PointerEvent("pointerdown", { button: 0, bubbles: true, pointerType: "mouse" }))
    await expect.poll(() => document.querySelectorAll('[role="option"]').length).toBeGreaterThan(0)
    ;[...document.querySelectorAll<HTMLElement>('[role="option"]')]
      .find((option) => option.textContent?.includes("Passive"))!
      .click()
    await expect.poll(() => groupView(group.id)?.group?.settings?.initiative).toBe("passive")
    expect(groupView(group.id)?.group?.settings?.planNeedsApproval).toBe(true)
    await connection.group.update({
      group: group.id,
      settings: { ...group.settings, initiative: "eager" },
    })
    await expect.poll(() => selector()?.textContent).toContain("Eager")
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
