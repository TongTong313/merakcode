import { Route, Router } from "@solidjs/router"
import { render } from "solid-js/web"
import { expect, test } from "vitest"
import { EngineEventSchema } from "@merakcode/sdk"
import { engineFixture } from "../../test/engine"
import { client } from "../../state/client"
import { setLocale } from "../../i18n"
import { localHuman } from "../../state/groups"
import { GroupConversation } from "../conversation/group-page"

test.each(["question", "permission"] as const)("answers a group %s as the named human", async (kind) => {
  const engine = await engineFixture({
    replies: [
      {
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
              calls: [
                {
                  id: "next-question",
                  name: "ask_human",
                  input: { to: localHuman, text: "Which shape?", options: ["Circle", "Square"] },
                },
              ],
            },
          ]),
      ...Array.from({ length: 8 }, () => ({ text: "Waiting for the answer." })),
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
    const profiles = await connection.profile.list({})
    const leader = await connection.profile.save({
      profile: { ...profiles![0]!, id: "", model: { provider: "fake", model: "fixture" } },
    })
    const worker = await connection.profile.save({
      profile: { ...profiles![1]!, id: "", model: { provider: "fake", model: "fixture" } },
    })
    const group = await connection.group.create({
      id: "",
      kind: "local",
      name: "Decisions",
      project: { directory: engine.project },
      defaultLeader: "leader",
      profiles: [],
      members: [
        { id: localHuman, group: "", kind: "human", name: "You", role: "owner", status: "idle" },
        { id: "other", group: "", kind: "human", name: "Other owner", role: "owner", status: "idle" },
        {
          id: "leader",
          group: "",
          kind: "agent",
          name: "Coordinator",
          agentRole: "leader",
          profile: leader.id,
          owner: localHuman,
          status: "idle",
        },
        {
          id: "worker",
          group: "",
          kind: "agent",
          name: "Writer",
          agentRole: "worker",
          profile: worker.id,
          owner: localHuman,
          status: "idle",
        },
      ],
    })
    dispose = render(
      () => (
        <Router>
          <Route path="/" component={() => <GroupConversation id={group.id} directory={engine.project} />} />
        </Router>
      ),
      host,
    )
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
    button("Inbox", host)!.click()
    const title = kind === "question" ? "Which color?" : "write_file"
    await expect.poll(() => button(title, host), { timeout: 10000 }).toBeDefined()
    button(title, host)!.click()
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
    await expect.poll(() => host.querySelector('[aria-label="To do"]')?.textContent).not.toContain(title)
    if (kind === "question") {
      await expect.poll(() => button("Which shape?", host), { timeout: 10000 }).toBeDefined()
      button("Which shape?", host)!.click()
      expect(document.querySelector('[aria-label="Question"]')?.textContent ?? "").not.toContain("Which color?")
      await expect.poll(() => document.querySelector('[aria-label="Question"]')?.textContent).toContain("Which shape?")
      button("Circle", document.querySelector('[aria-label="Question"]')!)!.click()
      button("Submit", document.querySelector('[aria-label="Question"]')!)!.click()
      await expect.poll(() => host.querySelector('[aria-label="To do"]')?.textContent).not.toContain("Which shape?")
    }
  } finally {
    dispose()
    host.remove()
    await (await client()).close()
    await engine.close()
  }
})
