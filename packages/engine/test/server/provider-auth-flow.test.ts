import { afterEach, describe, expect, test } from "vitest"
import path from "path"
import fs from "fs/promises"
import { fileURLToPath } from "url"
import { Instance } from "@merakcode/engine/project/instance"
import { Server } from "@merakcode/engine/server/server"
import { Filesystem } from "@merakcode/util/filesystem"
import { Log } from "@merakcode/log/logger"
import { tmpdir } from "../fixture/fixture"

Log.init({ print: false })

afterEach(async () => {
  await Instance.disposeAll().catch(() => undefined)
})

/**
 * A project plugin provides OAuth login for the acme provider: pick a deployment, and for enterprise enter the
 * required domain. The authorization URL is built from the answers, and enterprise credentials are stored under
 * acme-enterprise together with the domain.
 */
const plugin = `
export default async () => ({
  auth: {
    provider: "acme",
    methods: [
      {
        type: "oauth",
        label: "Login with Acme",
        prompts: [
          {
            type: "select",
            key: "deployment",
            message: "Deployment",
            options: [
              { label: "Acme Cloud", value: "cloud" },
              { label: "Acme Enterprise", value: "enterprise", hint: "self-hosted" },
            ],
          },
          {
            type: "text",
            key: "domain",
            message: "Enterprise domain",
            placeholder: "acme.example",
            condition: (inputs) => inputs.deployment === "enterprise",
            validate: (value) => (value ? undefined : "domain is required"),
          },
        ],
        async authorize(inputs = {}) {
          const host = inputs.deployment === "enterprise" ? inputs.domain : "login.acme.test"
          return {
            url: "https://" + host + "/device",
            method: "auto",
            instructions: "Enter code ABCD-1234",
            async callback() {
              return inputs.deployment === "enterprise"
                ? { type: "success", provider: "acme-enterprise", refresh: "r", access: "a", expires: 0, enterpriseUrl: host }
                : { type: "success", refresh: "r", access: "a", expires: 0 }
            },
          }
        },
      },
      { type: "api", label: "API key" },
    ],
  },
})
`

async function project() {
  return tmpdir({
    init: async (dir) => {
      const config = path.join(dir, ".merakcode")
      await fs.mkdir(path.join(config, "plugin"), { recursive: true })
      await fs.mkdir(path.join(config, "node_modules"), { recursive: true })
      await fs.symlink(
        path.dirname(fileURLToPath(import.meta.resolve("zod"))),
        path.join(config, "node_modules", "zod"),
        process.platform === "win32" ? "junction" : "dir",
      )
      await Filesystem.write(path.join(config, "plugin", "acme-auth.ts"), plugin)
    },
  })
}

function client(directory: string) {
  const app = Server.App()
  const query = `directory=${encodeURIComponent(directory)}`
  const get = async (url: string) => (await app.request(`${url}?${query}`)).json()
  const post = async (url: string, body: unknown) =>
    (
      await app.request(`${url}?${query}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      })
    ).json()
  return {
    methods: () => get("/provider/auth"),
    prompt: (inputs: Record<string, string>) => post("/provider/acme/oauth/prompt", { method: 0, inputs }),
    authorize: (inputs: Record<string, string>) => post("/provider/acme/oauth/authorize", { method: 0, inputs }),
    callback: () => post("/provider/acme/oauth/callback", { method: 0 }),
    credentials: () => get("/auth"),
  }
}

describe("provider login: plugin prompts, authorization and stored credentials", () => {
  test("asks conditional prompts in order, re-asking with the reason on invalid input", async () => {
    await using tmp = await project()
    const api = client(tmp.path)

    expect(await api.methods()).toMatchObject({
      acme: [
        { type: "oauth", label: "Login with Acme" },
        { type: "api", label: "API key" },
      ],
    })
    expect(await api.prompt({})).toEqual({
      prompt: {
        type: "select",
        key: "deployment",
        message: "Deployment",
        options: [
          { label: "Acme Cloud", value: "cloud" },
          { label: "Acme Enterprise", value: "enterprise", hint: "self-hosted" },
        ],
      },
    })
    expect(await api.prompt({ deployment: "cloud" })).toEqual({})
    expect(await api.prompt({ deployment: "enterprise" })).toEqual({
      prompt: { type: "text", key: "domain", message: "Enterprise domain", placeholder: "acme.example" },
    })
    expect(await api.prompt({ deployment: "enterprise", domain: "" })).toEqual({
      prompt: { type: "text", key: "domain", message: "Enterprise domain", placeholder: "acme.example" },
      error: "domain is required",
    })
    expect(await api.prompt({ deployment: "enterprise", domain: "acme.example" })).toEqual({})
  })

  test("authorizes, then stores credentials and extra data under the provider the plugin picks", async () => {
    await using tmp = await project()
    const api = client(tmp.path)

    expect(await api.authorize({ deployment: "enterprise", domain: "acme.example" })).toEqual({
      url: "https://acme.example/device",
      method: "auto",
      instructions: "Enter code ABCD-1234",
    })
    expect(await api.callback()).toBe(true)

    const listed = (await api.credentials()) as { file: string; credentials: { providerID: string; type: string }[] }
    expect(listed.credentials).toEqual([{ providerID: "acme-enterprise", type: "oauth" }])
    const saved = (await Filesystem.readJson(listed.file)) as Record<string, unknown>
    expect(saved["acme-enterprise"]).toEqual({
      type: "oauth",
      refresh: "r",
      access: "a",
      expires: 0,
      enterpriseUrl: "acme.example",
    })
  })
})
