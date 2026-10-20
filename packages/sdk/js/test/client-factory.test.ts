import { describe, expect, test } from "vitest"
import { createSdkClient, type ClientConfig } from "../src/client/client-factory.js"

class Client {
  constructor(readonly input: { client: { config?: ClientConfig } }) {}
}

function create(config?: ClientConfig) {
  return { config }
}

describe("shared SDK client transport", () => {
  test("adds the encoded directory header and default fetch transport", () => {
    const client = createSdkClient({ directory: "项目", headers: { accept: "application/json" } }, create, Client)
    const config = client.input.client.config

    expect(config?.headers).toEqual({
      accept: "application/json",
      "x-merakcode-directory": "%E9%A1%B9%E7%9B%AE",
    })
    expect(config?.fetch).toBeTypeOf("function")
    expect(config?.fetch).not.toBe(fetch)
  })

  test("preserves a provided fetch transport", () => {
    const client = createSdkClient({ fetch }, create, Client)
    expect(client.input.client.config?.fetch).toBe(fetch)
  })

  test("adds workspace-folders header when workspaceFolders provided", () => {
    const folders = [
      { name: "a", path: "/tmp/a" },
      { name: "b", path: "/tmp/b" },
    ]
    const client = createSdkClient({ directory: "/tmp/a", workspaceFolders: folders }, create, Client)
    const headers = client.input.client.config?.headers as Record<string, string>
    expect(headers["x-merakcode-directory"]).toBe("/tmp/a")
    expect(headers["x-merakcode-workspace-folders"]).toBe(encodeURIComponent(JSON.stringify(folders)))
  })

  test("omits workspace-folders header when workspaceFolders absent", () => {
    const client = createSdkClient({ directory: "/tmp/a" }, create, Client)
    const headers = client.input.client.config?.headers as Record<string, string>
    expect(headers["x-merakcode-directory"]).toBe("/tmp/a")
    expect(headers["x-merakcode-workspace-folders"]).toBeUndefined()
  })
})
