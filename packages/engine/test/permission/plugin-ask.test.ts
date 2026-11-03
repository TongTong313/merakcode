import { expect, test } from "vitest"
import fs from "node:fs/promises"
import path from "node:path"
import { Bus } from "../../src/infra/bus"
import { PermissionNext } from "../../src/agent/permission/next"
import { Instance } from "../../src/infra/project/instance"
import { Session } from "../../src/agent/session"
import { tmpdir } from "../fixture/fixture"
import { readySandbox } from "../fixture/sandbox-ready"

async function project(
  status: "ask" | "allow" | "deny" | "gate",
  fn: (input: PermissionNext.AskInput, directory: string) => Promise<void>,
) {
  using _isolation = readySandbox()
  await using tmp = await tmpdir({
    git: true,
    init: async (directory) => {
      const plugins = path.join(directory, ".merakcode", "plugin")
      await fs.mkdir(plugins, { recursive: true })
      await fs.writeFile(
        path.join(plugins, "permission.ts"),
        `
      import fs from "node:fs"
      import path from "node:path"
      export default {id:"permission-fixture",server:async ({directory})=>({
        "permission.ask":async (_input,output)=>{
          fs.writeFileSync(path.join(directory,"observed"),"seen")
          if (${JSON.stringify(status)} === "gate") while (!fs.existsSync(path.join(directory,"release"))) await new Promise(resolve=>setTimeout(resolve,5))
          output.status=${JSON.stringify(status === "gate" ? "ask" : status)}
        }
      })}
    `,
      )
    },
  })
  try {
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await Session.create({})
        await fn(
          {
            id: "permission_fixture",
            sessionID: session.id,
            permission: "bash",
            patterns: ["ls"],
            metadata: {},
            ruleset: [{ permission: "bash", pattern: "*", action: "ask" }],
          },
          tmp.path,
        )
      },
    })
  } finally {
    await fs.writeFile(path.join(tmp.path, "release"), "released")
  }
}

test("a plugin allow cannot replace the human approval", () =>
  project("allow", async (input) => {
    let asked = 0
    const unsubscribe = Bus.subscribe(PermissionNext.Event.Asked, (event) => {
      asked++
      void PermissionNext.reply({ requestID: event.properties.id, reply: "reject" })
    })
    try {
      await expect(PermissionNext.ask(input)).rejects.toBeInstanceOf(PermissionNext.RejectedError)
      expect(asked).toBe(1)
    } finally {
      unsubscribe()
    }
  }))

test("a plugin deny rejects the operation and leaves no approval pending", () =>
  project("deny", async (input) => {
    await expect(PermissionNext.ask(input)).rejects.toBeInstanceOf(PermissionNext.DeniedError)
    expect(await PermissionNext.list()).toEqual([])
  }))

test("a plugin ask waits for the actual human reply", () =>
  project("ask", async (input) => {
    const asked = Promise.withResolvers<string>()
    const unsubscribe = Bus.subscribe(PermissionNext.Event.Asked, (event) => asked.resolve(event.properties.id))
    const running = PermissionNext.ask(input)
    try {
      await PermissionNext.reply({ requestID: await asked.promise, reply: "once" })
      await expect(running).resolves.toBeUndefined()
    } finally {
      unsubscribe()
    }
  }))

test("a policy allow or deny settles before invoking the plugin", () =>
  project("deny", async (input, directory) => {
    await expect(
      PermissionNext.ask({ ...input, ruleset: [{ permission: "bash", pattern: "*", action: "allow" }] }),
    ).resolves.toBeUndefined()
    await expect(
      PermissionNext.ask({ ...input, ruleset: [{ permission: "bash", pattern: "*", action: "deny" }] }),
    ).rejects.toBeInstanceOf(PermissionNext.DeniedError)
    await expect(fs.stat(path.join(directory, "observed"))).rejects.toMatchObject({ code: "ENOENT" })
  }))

test("a reply during a running plugin hook is neither lost nor registered twice", () =>
  project("gate", async (input, directory) => {
    const running = PermissionNext.ask(input)
    try {
      await expect
        .poll(
          () =>
            fs.stat(path.join(directory, "observed")).then(
              () => true,
              () => false,
            ),
          { timeout: 5000 },
        )
        .toBe(true)
      await PermissionNext.reply({ requestID: input.id!, reply: "once" })
    } finally {
      await fs.writeFile(path.join(directory, "release"), "released")
    }
    await expect(running).resolves.toBeUndefined()
    expect(await PermissionNext.list()).toEqual([])
  }))
