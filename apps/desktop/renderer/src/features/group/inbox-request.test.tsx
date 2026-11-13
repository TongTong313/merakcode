import { Route, Router } from "@solidjs/router"
import { render } from "solid-js/web"
import { expect, test } from "vitest"
import { EngineEventSchema } from "@merakcode/sdk"
import { engineFixture } from "../../test/engine"
import { client } from "../../state/client"
import { setLocale } from "../../i18n"
import { connectGroups, groupsLoaded, loadGroups, localHuman } from "../../state/groups"
import { HomeInbox } from "../start/inbox"
import { connect } from "../../state/store"

test.each(["question", "permission"] as const)("answers a group %s as the named human", async (kind) => {
  const engine = await engineFixture({
    replies: [
      {
        role: kind === "question" ? "leader" : "worker",
        calls: [
          {
            id: "request",
            name: kind === "question" ? "ask_human" : "write_file",
            input:
              kind === "question"
                ? { to: localHuman, text: "Which color?", options: ["Blue", "Green"] }
                : { path: "answer.txt", content: "Approved write" },
          },
        ],
      },
      ...(kind === "permission"
        ? [
            {
              role: "worker",
              calls: [
                {
                  id: "report",
                  name: "submit_report",
                  input: { verdict: "done", summary: "Wrote the approved file." },
                },
              ],
            },
          ]
        : [
            {
              role: "leader",
              calls: [
                {
                  id: "next-question",
                  name: "ask_human",
                  input: { to: localHuman, text: "Which shape?", options: ["Circle", "Square"] },
                },
              ],
            },
          ]),
      ...Array.from({ length: 8 }, () => ({ role: "leader", text: "Waiting for the answer." })),
    ],
  })
  let dispose = () => {}
  const host = document.createElement("div")
  document.body.append(host)
  try {
    await engine.git("commit", "--allow-empty", "-m", "Fixture")
    location.href = engine.url
    setLocale("en")
    const connection = await client()
    const profiles = await connection.agent.list({})
    const leader = await connection.agent.save({
      agent: { ...profiles![0]!, id: "", model: { provider: "fake", model: "fixture" } },
    })
    const worker = await connection.agent.save({
      agent: { ...profiles![0]!, id: "", model: { provider: "fake", model: "fixture" } },
    })
    const group = await connection.group.create({
      id: "",
      kind: "local",
      name: "Decisions",
      project: { directory: engine.project },
      leader: "leader",
      members: [
        { id: localHuman, group: "", kind: "human", name: "You", role: "owner", status: "idle" },
        { id: "other", group: "", kind: "human", name: "Other owner", role: "owner", status: "idle" },
        {
          id: "leader",
          group: "",
          kind: "agent",
          name: "Coordinator",
          agentRole: "leader",
          agent: leader.id,
          owner: localHuman,
          status: "idle",
        },
        {
          id: "worker",
          group: "",
          kind: "agent",
          name: "Writer",
          agentRole: "worker",
          agent: worker.id,
          owner: localHuman,
          status: "idle",
        },
      ],
    })
    const stopStore = connect()
    const stopGroups = connectGroups()
    await loadGroups()
    await groupsLoaded()
    const unmount = render(
      () => (
        <Router>
          <Route path="/" component={() => <HomeInbox />} />
        </Router>
      ),
      host,
    )
    dispose = () => {
      unmount()
      stopGroups()
      stopStore()
    }
    if (kind === "question") await connection.group.say({ group: group.id, text: "Ask me to choose the color." })
    else
      await connection.task.create({
        group: group.id,
        member: "worker",
        title: "Write a file",
        review: true,
      })
    const button = (label: string, root: ParentNode = document) =>
      [...root.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent?.trim() === label)
    const open = (text: string) =>
      [...host.querySelectorAll<HTMLElement>("article[data-pending=true]")]
        .find((article) => article.textContent?.includes(text))
        ?.querySelector<HTMLButtonElement>("button[data-open]")
    const title = kind === "question" ? "Which color?" : "write_file"
    await expect.poll(() => open(title), { timeout: 10000 }).toBeDefined()
    open(title)!.click()
    const region = kind === "question" ? "Question" : "Approval"
    await expect.poll(() => document.querySelector(`[aria-label="${region}"]`)).not.toBeNull()
    const request = document.querySelector(`[aria-label="${region}"]`)!
    if (kind === "question") {
      button("Blue", request)!.click()
      button("Submit", request)!.click()
    } else button("Allow once", request)!.click()
    await expect
      .poll(
        async () => {
          const facts = (await connection.events.read({ stream: `group:${group.id}`, from: 1 }))!.map((fact) =>
            EngineEventSchema.parse(fact),
          )
          const answer = facts.find(
            (fact) => fact.type === (kind === "question" ? "question.answered" : "permission.replied"),
          )
          if (answer?.type === "question.answered") return { text: answer.payload.text, human: answer.actor.id }
          if (answer?.type === "permission.replied") return { text: answer.payload.decision, human: answer.actor.id }
        },
        { timeout: 10000 },
      )
      .toEqual({ text: kind === "question" ? "Blue" : "allow", human: localHuman })
    await expect.poll(() => host.querySelector('[aria-label="Inbox"]')?.textContent).not.toContain(title)
    if (kind === "question") {
      await expect.poll(() => open("Which shape?"), { timeout: 10000 }).toBeDefined()
      open("Which shape?")!.click()
      expect(document.querySelector('[aria-label="Question"]')?.textContent ?? "").not.toContain("Which color?")
      await expect.poll(() => document.querySelector('[aria-label="Question"]')?.textContent).toContain("Which shape?")
      button("Circle", document.querySelector('[aria-label="Question"]')!)!.click()
      button("Submit", document.querySelector('[aria-label="Question"]')!)!.click()
      await expect.poll(() => host.querySelector('[aria-label="Inbox"]')?.textContent).not.toContain("Which shape?")
    }
  } finally {
    dispose()
    host.remove()
    await (await client()).close()
    await engine.close()
  }
})
