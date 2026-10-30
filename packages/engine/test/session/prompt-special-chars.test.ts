import { SessionOperations } from "@merakcode/engine/app/session"
import path from "path"
import { describe, expect, test } from "vitest"
import { fileURLToPath } from "url"
import { Instance } from "@merakcode/engine/infra/project/instance"
import { Log } from "@merakcode/log/logger"
import { Session } from "@merakcode/engine/agent/session/index"
import { Loop } from "@merakcode/engine/agent/loop/index"
import { Message } from "@merakcode/engine/agent/session/message"
import { tmpdir } from "../fixture/fixture"
import { Filesystem } from "@merakcode/util/filesystem"
import { Config } from "../../src/app/config/files/config"

Log.init({ print: false })

describe("session.prompt special characters", () => {
  test("handles filenames with # character", async () => {
    await using tmp = await tmpdir({
      git: true,
      init: async (dir) => {
        await Filesystem.write(path.join(dir, "file#name.txt"), "special content\n")
        await Filesystem.write(
          path.join(dir, "merakcode.json"),
          JSON.stringify({
            $schema: Config.SCHEMA,
            model: "custom-provider/custom-model",
            provider: {
              "custom-provider": {
                name: "Custom Provider",
                npm: "@ai-sdk/openai-compatible",
                api: "https://api.custom.com/v1",
                options: { apiKey: "test-key" },
                models: {
                  "custom-model": {
                    id: "custom-model",
                    name: "Custom Model",
                    tool_call: true,
                  },
                },
              },
            },
          }),
        )
      },
    })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await Session.create({})
        const template = "Read @file#name.txt"
        const parts = await Loop.resolvePromptParts(template)
        const fileParts = parts.filter((part) => part.type === "file")

        expect(fileParts.length).toBe(1)
        expect(fileParts[0].filename).toBe("file#name.txt")

        // Verify the URL is properly encoded (# should be %23)
        expect(fileParts[0].url).toContain("%23")

        // Verify the URL can be correctly converted back to a file path
        const decodedPath = fileURLToPath(fileParts[0].url)
        expect(decodedPath).toBe(path.join(tmp.path, "file#name.txt"))

        const message = await Loop.prompt({
          sessionID: session.id,
          parts,
          noReply: true,
        })
        const stored = await Message.get({ sessionID: session.id, messageID: message.info.id })

        // Verify the file content was read correctly
        const textParts = stored.parts.filter((part) => part.type === "text")
        const hasContent = textParts.some((part) => part.text.includes("special content"))
        expect(hasContent).toBe(true)

        await SessionOperations.remove(session.id)
      },
    })
  })
})
