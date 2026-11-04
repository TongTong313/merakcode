import { expect, test } from "vitest"
import { execFileSync } from "node:child_process"
import { createMerakCode } from "@merakcode/sdk"
import { engine, sandbox } from "../fixture/engine"
import { fakeModel } from "../fixture/model"

test.each(["ask", "autoApprove", "fullTakeover"] as const)(
  "SDK draft-only Git history preserves %s and its approval policy",
  async (permissionLevel) => {
    const model = await fakeModel(({ results }) =>
      results.length
        ? { text: results.at(-1)! }
        : { tool: "bash", args: { command: "git log --oneline -1", description: "Read recent history" } },
    )
    await using env = await sandbox(model.url)
    execFileSync(
      "git",
      [
        "-c",
        "user.name=SDK Test",
        "-c",
        "user.email=sdk@example.com",
        "commit",
        "--allow-empty",
        "-m",
        "DRAFT_HISTORY_OK",
      ],
      { cwd: env.project },
    )
    const merak = await createMerakCode({ cwd: env.project, executablePath: engine, env: env.env })
    try {
      const session = await merak.session()
      let approvals = 0
      let text = ""
      for await (const event of session.run("Draft only. Do not modify the project. Inspect recent history.", {
        permissionLevel,
        onPermission: () => {
          approvals++
          return "allow-once"
        },
      }))
        if (event.type === "text") text += event.delta
      expect(text).toContain("DRAFT_HISTORY_OK")
      expect(approvals).toBe(permissionLevel === "fullTakeover" ? 0 : 1)
      expect((await merak.client.session.get({ sessionID: session.id })).data?.permissionLevel).toBe(permissionLevel)
    } finally {
      await merak.close()
      await model.close()
    }
  },
  120_000,
)
