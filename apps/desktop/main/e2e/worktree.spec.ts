import { access, readFile } from "node:fs/promises"
import path from "node:path"
import { connect } from "@merakcode/sdk"
import { test, expect, type Kit } from "./fixture"

test.use({ git: true, claude: true, script: { reply: () => ({ tool: "say", args: { text: "隔离任务已记录。" } }) } })

/** The group form picks the workspace from the open folders, so another spelling of the path goes in through the engine. */
async function groupAt(kit: Kit, directory: string) {
  const info = JSON.parse(await readFile(path.join(kit.root, "data", "engine.json"), "utf8"))
  const rpc = await connect(info)
  try {
    const product = (await rpc.agent.catalog())!.find((item) => item.kind === "claude-code")!
    const worker = await rpc.agent.save({
      agent: {
        id: "",
        name: "Claude Code",
        summary: "",
        duties: "",
        toolPool: "worker.default",
        model: { provider: "", model: "" },
        product: { kind: "claude-code", binary: product.binary! },
      },
    })
    await rpc.group.create({
      id: "",
      kind: "local",
      name: "隔离协作",
      project: { directory },
      leader: "leader",
      members: [
        { id: rpc.hello.human, group: "", kind: "human", name: "You", role: "owner", status: "idle" },
        {
          id: "leader",
          group: "",
          kind: "agent",
          name: "Leader",
          agentRole: "leader",
          agent: "builtin-merakcode",
          owner: rpc.hello.human,
          status: "idle",
        },
        {
          id: "worker",
          group: "",
          kind: "agent",
          name: "Claude-Code",
          agentRole: "worker",
          agent: worker.id,
          owner: rpc.hello.human,
          status: "idle",
        },
      ],
    })
  } finally {
    await rpc.close()
  }
  await kit.page.reload()
  await kit.page.getByRole("link", { name: "隔离协作" }).click()
}

for (const spelling of ["original", "alternate"]) {
  test(`runs a member claim in its own worktree with an ${spelling} project path`, async ({ kit }) => {
    const branch = kit.git("branch", "--show-current").trim()
    const head = kit.git("rev-parse", "HEAD").trim()
    if (spelling === "alternate") await groupAt(kit, kit.project.replaceAll("\\", "/") + "/")
    else {
      await kit.page.getByRole("button", { name: "新建智能体", exact: true }).click()
      await kit.page.keyboard.press("Escape")
      await kit.page.getByRole("button", { name: "添加 Claude Code", exact: true }).click()
      await expect(kit.page.getByRole("button", { name: "已添加 Claude Code", exact: true })).toBeDisabled()
      await kit.page.getByRole("button", { name: "新建协作群", exact: true }).click()
      const dialog = kit.page.getByRole("dialog")
      await dialog.getByRole("textbox", { name: "群名称" }).fill("隔离协作")
      await dialog.getByRole("checkbox", { name: "选择 Claude Code", exact: true }).check()
      await dialog.getByRole("button", { name: "创建", exact: true }).click()
    }
    await expect(kit.page.getByRole("log", { name: "群聊" })).toBeVisible()
    await kit.send("@Claude-Code 检查隔离任务")
    const worktrees = () =>
      kit
        .git("worktree", "list", "--porcelain")
        .split("\n")
        .filter((line) => line.startsWith("worktree "))
        .map((line) => line.slice(9).trim())
    await expect.poll(() => worktrees().length).toBe(2)
    const worktree = worktrees().find((directory) => path.resolve(directory) !== path.resolve(kit.project))!
    expect(path.relative(kit.project, worktree).split(path.sep).slice(0, 2)).toEqual([".merak", "worktrees"])
    await expect
      .poll(() => readFile(path.join(worktree, "inputs.json"), "utf8").catch(() => ""))
      .toContain("检查隔离任务")
    await expect(kit.page.getByRole("group", { name: "成员 Claude-Code", exact: true })).toContainText("空闲")
    await expect(access(path.join(kit.project, "inputs.json"))).rejects.toThrow()
    expect(kit.git("branch", "--show-current").trim()).toBe(branch)
    expect(kit.git("rev-parse", "HEAD").trim()).toBe(head)
    expect(kit.git("branch", "--list", "merak/*").trim()).not.toBe("")
    await kit.page.reload()
    await expect(kit.page.getByRole("log", { name: "群聊" })).toContainText("@Claude-Code 检查隔离任务")
    expect(worktrees()).toContain(worktree)
  })
}
