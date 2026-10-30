// System prompt: product identity, where output is shown, reply language.
import { afterEach, describe, expect, test } from "vitest"
import { SystemPrompt } from "../context/system"
import type { Provider } from "../model/provider"
import type { Message } from "./message"

/** Minimal Model, just enough for SystemPrompt.provider to pick a prompt by api.id */
const model = (id: string) => ({ api: { id } }) as unknown as Provider.Model

/** One model per prompt branch in SystemPrompt.provider (six prompts) */
const FAMILIES = ["gpt-5", "gpt-4o", "gemini-2.5-pro", "claude-sonnet-4", "trinity-large", "qwen3-coder"]

describe("identity", () => {
  for (const family of FAMILIES) {
    test(`${family}: introduces itself as MerakCode with no placeholders left`, () => {
      const [text] = SystemPrompt.provider(model(family))
      expect(text!.startsWith("You are MerakCode, an open-source AI coding agent.")).toBe(true)
      expect(text).not.toContain("{{")
    })
  }

  test("keeps the prompt body intact", () => {
    const [text] = SystemPrompt.provider(model("claude-sonnet-4"))
    expect(text).toContain("IMPORTANT: You must NEVER generate or guess URLs")
    expect(text).toContain("- ctrl+p to list available actions")
    expect(text).toContain("users should visit the MerakCode issue tracker")
  })
})

describe("describes where output is shown based on the client", () => {
  const client = process.env.MERAKCODE_CLIENT
  afterEach(() => {
    if (client === undefined) delete process.env.MERAKCODE_CLIENT
    else process.env.MERAKCODE_CLIENT = client
  })

  test("desktop: does not claim to be a CLI tool and says output is shown in the desktop app", () => {
    process.env.MERAKCODE_CLIENT = "desktop"
    for (const family of FAMILIES) {
      const [text] = SystemPrompt.provider(model(family))
      expect(text, family).not.toMatch(/CLI tool|CLI agent|command line interface/)
    }
    const [qwen] = SystemPrompt.provider(model("qwen3-coder"))
    expect(qwen).toContain("displayed in the MerakCode desktop app")
  })

  test("command line: says output is shown in a terminal", () => {
    process.env.MERAKCODE_CLIENT = "cli"
    const [qwen] = SystemPrompt.provider(model("qwen3-coder"))
    expect(qwen).toContain("displayed in a terminal")
    expect(qwen).not.toContain("{{")
  })
})

// At the end of the prompt, the English examples in the body often win out over the language instruction.
test("every prompt asks to reply in the user's language, near the top", () => {
  for (const family of FAMILIES) {
    const [text] = SystemPrompt.provider(model(family))
    const at = text!.indexOf("reply in the language of the user's latest message")
    expect(at, family).toBeGreaterThan(0)
    // right after the first paragraph (the identity)
    expect(at, family).toBeLessThan(text!.indexOf("\n\n", text!.indexOf("\n\n") + 2) + 2)
  }
})

// With only the general instruction at the top, the model often ends in English after a few rounds of tool output.
describe("names the reply language from the latest user message", () => {
  const user = (...parts: { text: string; synthetic?: boolean }[]) =>
    ({ info: { role: "user" }, parts: parts.map((part) => ({ type: "text", ...part })) }) as unknown as Message.FullMsg
  const assistant = {
    info: { role: "assistant" },
    parts: [{ type: "text", text: "Done." }],
  } as unknown as Message.FullMsg

  test("names Chinese for a Chinese question mixed with code identifiers", () => {
    const [text] = SystemPrompt.replyLanguage([user({ text: "把 handleClick 改成 async，然后更新 test" }), assistant])
    expect(text).toContain("in Chinese")
  })

  test("a few quoted Chinese characters in English do not count; Japanese and Korean are named", () => {
    expect(SystemPrompt.replyLanguage([user({ text: "translate '你好' into English please" })])).toEqual([])
    expect(SystemPrompt.replyLanguage([user({ text: "このファイルを読んでください" })])[0]).toContain("in Japanese")
    expect(SystemPrompt.replyLanguage([user({ text: "이 파일을 읽어 주세요" })])[0]).toContain("in Korean")
  })

  test("synthetic user messages such as mode switch notes do not change the user's language", () => {
    const messages = [
      user({ text: "读一下 in.txt" }),
      assistant,
      user({ text: "Plan mode is now off.", synthetic: true }),
    ]
    expect(SystemPrompt.replyLanguage(messages)[0]).toContain("in Chinese")
  })
})
