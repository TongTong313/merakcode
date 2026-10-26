import { execFileSync } from "node:child_process"
import { chmod } from "node:fs/promises"
import path from "node:path"
import { expect, test } from "vitest"
import { Filesystem } from "@merakcode/util/filesystem"
import { createMerakCode } from "@merakcode/sdk"
import { engine, sandbox } from "../fixture/engine"
import { fakeModel } from "../fixture/model"

test("recovery from another worktree protects the session's actual checkout", async () => {
  let file = ""
  const model = await fakeModel((turn) => {
    if (!turn.results.length) return { tool: "read", args: { filePath: file } }
    if (turn.results.length === 1) return { tool: "write", args: { filePath: file, content: "agent edit\n" } }
    return { text: "Edited" }
  })
  await using env = await sandbox(model.url)
  const git = (...args: string[]) =>
    execFileSync("git", ["-c", "user.name=Recovery Test", "-c", "user.email=recovery@example.test", ...args], {
      cwd: env.project,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim()
  file = path.join(env.project, "file.txt")
  await Filesystem.write(file, "initial\n")
  git("config", "core.autocrlf", "false")
  git("add", "file.txt")
  git("commit", "--quiet", "-m", "initial")
  git("branch", "-M", "main")
  git("branch", "dev")
  const linked = path.join(env.root, "linked")
  git("worktree", "add", "--quiet", "-b", "linked", linked)
  const merak = await createMerakCode({ cwd: env.project, executablePath: engine, env: env.env })
  const release = path.join(env.root, "checkout-release")
  let switching: ReturnType<typeof merak.client.vcs.switchBranch> | undefined
  try {
    const session = await merak.session()
    for await (const event of session.run("Edit the tracked file", { mode: "auto" })) void event
    const messages = (await merak.client.session.messages({ sessionID: session.id }, { throwOnError: true })).data
    const user = messages.find((message) => message.info.role === "user")!
    git("commit", "--quiet", "-am", "agent edit")
    const marker = path.join(env.root, "checkout-entered")
    const helper = path.join(env.root, "checkout-hook.cjs")
    await Filesystem.write(
      helper,
      'const fs = require("node:fs"); fs.writeFileSync(process.argv[2], "ready"); const end = Date.now() + 15000; while (!fs.existsSync(process.argv[3]) && Date.now() < end) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);',
    )
    const forward = (value: string) => value.replaceAll("\\", "/")
    const hook = path.join(env.project, ".git", "hooks", "post-checkout")
    await Filesystem.write(hook, `#!/bin/sh\nnode "${forward(helper)}" "${forward(marker)}" "${forward(release)}"\n`)
    await chmod(hook, 0o755)
    const before = (await merak.client.vcs.branchOptions({}, { throwOnError: true })).data.current!
    switching = merak.client.vcs.switchBranch({ branch: "dev", expectedCheckout: before.checkout })
    await expect.poll(() => Filesystem.readText(marker).catch(() => ""), { timeout: 10_000 }).toBe("ready")
    const recovered = await merak.client.session.revert({
      directory: linked,
      sessionID: session.id,
      messageID: user.info.id,
    })
    expect(recovered.response.status).toBe(409)
    expect(recovered.error).toMatchObject({ name: "CheckoutBlockedError" })
  } finally {
    await Filesystem.write(release, "release")
    await switching
    await merak.close()
    await model.close()
  }
}, 120_000)
