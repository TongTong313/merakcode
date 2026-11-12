import { readFile } from "node:fs/promises"
import path from "node:path"
import { connect } from "@merakcode/sdk"
import { test, expect, type Kit } from "./fixture"

test.use({ git: true, script: { reply: () => ({ tool: "say", args: { text: "已记录。" } }) } })

async function engineOf(kit: Kit) {
  return connect(JSON.parse(await readFile(path.join(kit.root, "data", "engine.json"), "utf8")))
}

async function newTask(kit: Kit, title: string) {
  await kit.page.getByRole("button", { name: "新建任务", exact: true }).click()
  const dialog = kit.page.getByRole("dialog")
  await dialog.getByRole("textbox", { name: "标题", exact: true }).fill(title)
  await dialog.getByRole("button", { name: "创建任务", exact: true }).click()
  await expect(dialog).toBeHidden()
  await expect(kit.page.getByRole("heading", { name: title, exact: true })).toBeVisible()
}

async function newGroup(kit: Kit, name: string) {
  await kit.page.getByRole("button", { name: "新建协作群", exact: true }).click()
  const dialog = kit.page.getByRole("dialog")
  await dialog.getByRole("textbox", { name: "群名称" }).fill(name)
  await dialog.getByRole("button", { name: "创建", exact: true }).click()
  await expect(kit.page.getByRole("log", { name: "群聊" })).toBeVisible()
}

test("a task made alone starts a new group in its own workspace, and the group takes the task", async ({ kit }) => {
  await newTask(kit, "独立任务")
  const start = kit.page.getByRole("region", { name: "任务要交给协作群才会开始", exact: true })
  await expect(start).toBeVisible()
  await start.getByRole("button", { name: "新建协作群", exact: true }).click()
  const dialog = kit.page.getByRole("dialog")
  await expect(dialog.getByRole("button", { name: /^工作空间/ })).toBeDisabled()
  await expect(dialog).toContainText("工作空间取自任务，不能修改")
  await dialog.getByRole("textbox", { name: "群名称" }).fill("任务群")
  await dialog.getByRole("button", { name: "创建", exact: true }).click()
  await expect(kit.page.getByRole("log", { name: "群聊" })).toBeVisible()
  await expect(kit.page.getByRole("region", { name: "任务拆解", exact: true })).toContainText("独立任务")
  await expect(kit.page.getByRole("link", { name: "任务群" })).toBeVisible()
})

test("a task made alone is given to an existing group, which then shows as its group with its Leader", async ({
  kit,
}) => {
  await newGroup(kit, "已有的群")
  await newTask(kit, "交给已有群")
  await kit.page.getByRole("button", { name: "选择协作群", exact: true }).click()
  const dialog = kit.page.getByRole("dialog")
  const row = dialog.getByRole("article").filter({ hasText: "已有的群" })
  await expect(row).not.toContainText("选了以后这个群的工作空间会改成任务的")
  await row.getByRole("button", { name: "选这个", exact: true }).click()
  await expect(kit.page.getByRole("button", { name: "已有的群", exact: true })).toBeVisible()
  await expect(kit.page.getByText("Leader", { exact: true }).first()).toBeVisible()
  await expect(kit.page.getByRole("button", { name: "新建协作群", exact: true })).toHaveCount(1)
  await expect(kit.page.getByRole("button", { name: "选择协作群", exact: true })).toHaveCount(0)
  await kit.page.getByRole("button", { name: "已有的群", exact: true }).click()
  await expect(kit.page.getByRole("log", { name: "群聊" })).toBeVisible()
})

test("cards are archived from the board, found in the archive and restored; unfinished ones ask first", async ({
  kit,
}) => {
  await newGroup(kit, "看板群")
  const rpc = await engineOf(kit)
  try {
    const [group] = (await rpc.group.list())!
    for (const title of ["完成甲", "完成乙"]) {
      const card = await rpc.task.create({ group: group!.id, title })
      await rpc.task.cancel({ task: card.id })
    }
    await rpc.task.create({ group: group!.id, title: "还在进行" })
  } finally {
    await rpc.close()
  }
  await kit.page.getByRole("link", { name: "首页", exact: true }).click()
  await kit.page.getByRole("button", { name: "展开", exact: true }).click()
  const finished = kit.page.getByRole("region", { name: "完成", exact: true })
  await expect(finished).toContainText("完成甲")
  await finished.getByRole("button", { name: "归档 完成甲", exact: true }).click()
  await expect(finished).not.toContainText("完成甲")
  await kit.page.getByRole("radio", { name: "已归档", exact: true }).click()
  const archived = kit.page.getByRole("region", { name: "已归档", exact: true })
  await expect(archived).toContainText("完成甲")
  await archived.getByRole("textbox", { name: "搜索已归档的任务", exact: true }).fill("不存在")
  await expect(archived).toContainText("没有匹配的任务。")
  await archived.getByRole("textbox", { name: "搜索已归档的任务", exact: true }).fill("完成")
  await archived.getByRole("button", { name: "恢复 完成甲", exact: true }).click()
  await expect(archived).not.toContainText("完成甲")
  await kit.page.getByRole("radio", { name: "任务看板", exact: true }).click()
  await expect(finished).toContainText("完成甲")
  const dialog = kit.page.getByRole("dialog")
  await kit.page.getByRole("button", { name: "归档 还在进行", exact: true }).click()
  await expect(dialog).toContainText("这个任务还没有结束")
  await dialog.getByRole("button", { name: "取消", exact: true }).click()
  await expect(kit.page.getByRole("button", { name: "归档 还在进行", exact: true })).toBeVisible()
  await kit.page.getByRole("button", { name: "归档 还在进行", exact: true }).click()
  await dialog.getByRole("button", { name: "取消并归档", exact: true }).click()
  await expect(kit.page.getByRole("button", { name: "归档 还在进行", exact: true })).toHaveCount(0)
  await expect(finished).toContainText("完成甲")
  await finished.getByRole("button", { name: /^全部归档/ }).click()
  await expect(finished.getByRole("button", { name: /^归档 / })).toHaveCount(0)
  await kit.page.getByRole("radio", { name: "已归档", exact: true }).click()
  await expect(archived).toContainText("完成甲")
  await expect(archived).toContainText("完成乙")
  await expect(archived).toContainText("还在进行")
})

test("the auto-archive days are chosen in the settings", async ({ kit }) => {
  await kit.settings(/^任务看板$/)
  const region = kit.page.getByRole("region", { name: "任务看板", exact: true })
  await expect(region.getByRole("radio", { name: "3 天", exact: true })).toBeChecked()
  await region.getByRole("radio", { name: "14 天", exact: true }).click()
  await expect(region.getByRole("radio", { name: "14 天", exact: true })).toBeChecked()
  const saved = JSON.parse(await readFile(path.join(kit.root, "merakcode.json"), "utf8")) as {
    board?: { autoArchiveDays?: number }
  }
  expect(saved.board?.autoArchiveDays).toBe(14)
  await kit.page.reload()
  await kit.settings(/^任务看板$/)
  await expect(region.getByRole("radio", { name: "14 天", exact: true })).toBeChecked()
})
