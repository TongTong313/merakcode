import { describe, expect, test } from "vitest"
import { MemorySecretScan } from "@merakcode/engine/memory/secret-scan"
import { MemoryAccess } from "@merakcode/engine/memory/access"
import { Instance } from "@merakcode/engine/project/instance"
import { MemoryPath } from "@merakcode/engine/memory/path"
import path from "path"
import { tmpdir } from "../fixture/fixture"

describe("MemorySecretScan.scan", () => {
  test("detects AWS access key", () => {
    expect(MemorySecretScan.scan("key: AKIAABCDEFGHIJKLMNOP")).toContain("aws-access-key")
  })

  test("detects Anthropic API key", () => {
    expect(MemorySecretScan.scan("export ANTHROPIC_API_KEY=sk-ant-api03-abcdefghijklmnopqrstuvwxyz")).toContain(
      "anthropic-api-key",
    )
  })

  test("detects OpenAI API key", () => {
    expect(MemorySecretScan.scan("sk-proj-abcdefghijklmnopqrstuvwxyz1234567890")).toContain("openai-api-key")
  })

  test("detects GitHub token", () => {
    expect(MemorySecretScan.scan("ghp_" + "a".repeat(36))).toContain("github-token")
  })

  test("detects private key block", () => {
    expect(MemorySecretScan.scan("-----BEGIN RSA PRIVATE KEY-----\nMIIExyz\n-----END RSA PRIVATE KEY-----")).toContain(
      "private-key-block",
    )
  })

  test("no false positive on ordinary memory content", () => {
    expect(
      MemorySecretScan.scan(
        "用户偏好使用 uv 管理 Python 环境，bun 管理 Node.js 环境。之前建议过用 AKIA 开头的凭证格式做示例说明，但没有真实值。",
      ),
    ).toEqual([])
  })

  test("no false positive on plain code snippet", () => {
    expect(
      MemorySecretScan.scan("const apiKey = process.env.MY_API_KEY\nfunction fetchData() { return apiKey }"),
    ).toEqual([])
  })
})

describe("MemoryAccess.assertNoSecrets", () => {
  test("throws when content contains a matched secret pattern", () => {
    expect(() => MemoryAccess.assertNoSecrets("AKIAABCDEFGHIJKLMNOP")).toThrow()
  })

  test("does not throw for ordinary content", () => {
    expect(() => MemoryAccess.assertNoSecrets("记住：用户偏好中文交流")).not.toThrow()
  })
})

describe("MemoryAccess.isWritablePath with assertNoSecrets, as called by the write/edit tools", () => {
  test("paths inside the memory directory are writable and paths outside are not", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const memoryFile = MemoryPath.topic("user", "test-note")
        expect(MemoryAccess.isWritablePath(memoryFile)).toBe(true)
        expect(MemoryAccess.isWritablePath(path.join(tmp.path, "src", "index.ts"))).toBe(false)
      },
    })
  })
})
