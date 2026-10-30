import { describe, expect, test } from "vitest"
import { Redact } from "@merakcode/engine/infra/security/redact"

describe("Redact.secrets", () => {
  test("API keys and tokens by their well-known shapes", () => {
    const text = [
      "openai sk-proj-AbCdEfGhIjKlMnOpQrStUvWx123456",
      "anthropic sk-ant-api03-AbCdEfGhIjKlMnOpQrStUv",
      "aws AKIAIOSFODNN7EXAMPLE",
      "github ghp_aBcDeFgHiJkLmNoPqRsTuVwXyZ0123456789",
      "github_pat_11ABCDEFG0123456789_abcdefghijklmnopqrstuvwxyz",
      "slack xoxb-1234567890-abcdefghij",
    ].join("\n")
    const result = Redact.secrets(text)
    for (const secret of [
      "sk-proj-AbCd",
      "sk-ant-api03",
      "AKIAIOSFODNN7EXAMPLE",
      "ghp_aBcD",
      "github_pat_11",
      "xoxb-1234",
    ])
      expect(result, secret).not.toContain(secret)
    expect(result).toContain("openai <redacted>")
    expect(result).toContain("aws <redacted>")
  })

  test("private key blocks", () => {
    const key = "-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAAA\n-----END OPENSSH PRIVATE KEY-----"
    expect(Redact.secrets(`before\n${key}\nafter`)).toBe("before\n<redacted private key>\nafter")
  })

  test("values of *_KEY, *_TOKEN, *_SECRET and PASSWORD assignments", () => {
    const text =
      'API_KEY=abc123\nGITHUB_TOKEN="ghs xyz"\nclient_secret: s3cr3t\nDB_PASSWORD=hunter2\nexport AWS_SECRET_ACCESS_KEY=wJalr'
    const result = Redact.secrets(text)
    expect(result).toBe(
      "API_KEY=<redacted>\nGITHUB_TOKEN=<redacted>\nclient_secret: <redacted>\nDB_PASSWORD=<redacted>\nexport AWS_SECRET_ACCESS_KEY=<redacted>",
    )
  })

  test("ordinary output is left alone", () => {
    const text = "Tests 42 passed\nskip-this ok\nPASSWORD_POLICY is strict\nkey: value"
    expect(Redact.secrets(text)).toBe(text)
  })
})
