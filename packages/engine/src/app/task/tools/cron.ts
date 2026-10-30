import z from "zod"
import { Tool } from "../../../agent/tools/tool"
import { CronScheduler } from "../cron"
import { Text } from "../../../agent/prompt/text"

const MIN_INTERVAL_MS = 60_000

export const CronCreateTool = Tool.define("CronCreate", {
  description: "Create a scheduled task that runs the given prompt periodically in the background",
  parameters: z.object({
    interval: z
      .number()
      .min(MIN_INTERVAL_MS)
      .describe(`Interval between runs in milliseconds, minimum ${MIN_INTERVAL_MS} (1 minute)`),
    prompt: z.string().describe("The prompt or command to run"),
  }),
  async execute(params, ctx) {
    await ctx.ask({
      permission: "cron",
      patterns: ["*"],
      metadata: { op: "create" },
    })
    const id = await CronScheduler.create({
      interval: params.interval,
      prompt: params.prompt,
      sessionID: ctx.sessionID,
      agent: ctx.agent,
      permissionMode: ctx.permissionMode ?? ctx.kind,
      model: currentModel(ctx.extra?.model),
    })

    return {
      title: await Text.pick({ zh: "定时任务已创建", en: "Scheduled task created" }),
      output: `Task ID: ${id}\nInterval: ${formatInterval(params.interval)}\nTask: ${params.prompt}`,
      metadata: { id },
    }
  },
})

export const CronListTool = Tool.define("CronList", {
  description: "List all scheduled tasks and their status",
  parameters: z.object({}),
  async execute(_params, ctx) {
    await ctx.ask({
      permission: "cron",
      patterns: ["*"],
      metadata: { op: "list" },
    })
    const tasks = CronScheduler.list(ctx.sessionID)

    if (tasks.length === 0) {
      return {
        title: await Text.pick({ zh: "无定时任务", en: "No scheduled tasks" }),
        output: "There are no scheduled tasks running",
        metadata: { tasks: [] },
      }
    }

    const output = tasks
      .map(
        (task, i) =>
          `${i + 1}. ID: ${task.id}\n` +
          `   Interval: ${formatInterval(task.interval)}\n` +
          `   Task: ${task.prompt}\n` +
          `   Status: ${task.status === "running" ? "running" : "paused"}\n` +
          `   Next run: ${formatTime(task.nextRun)}\n` +
          `   Last run: ${task.lastRun ? formatTime(task.lastRun) + " (" + (task.lastStatus === "success" ? "succeeded" : "failed") + ")" : "never"}`,
      )
      .join("\n\n")

    return {
      title: await Text.pick({ zh: "当前定时任务", en: "Scheduled tasks" }),
      output,
      metadata: { tasks },
    }
  },
})

export const CronDeleteTool = Tool.define("CronDelete", {
  description: "Delete the given scheduled task",
  parameters: z.object({
    id: z.string().describe("Task ID"),
  }),
  async execute(params, ctx) {
    await ctx.ask({
      permission: "cron",
      patterns: ["*"],
      metadata: { op: "delete", id: params.id },
    })
    const success = await CronScheduler.remove(params.id)

    if (!success) {
      throw new Error(await Text.pick({ zh: "任务 {id} 不存在", en: "Task {id} does not exist" }, { id: params.id }))
    }

    return {
      title: await Text.pick({ zh: "任务已删除", en: "Task deleted" }),
      output: `Deleted task ${params.id}`,
      metadata: { id: params.id },
    }
  },
})

function formatInterval(ms: number): string {
  if (ms < 60000) return `every ${ms / 1000} seconds`
  if (ms < 3600000) return `every ${ms / 60000} minutes`
  return `every ${ms / 3600000} hours`
}

function formatTime(timestamp: number): string {
  return new Date(timestamp).toLocaleString("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  })
}

function currentModel(model: unknown) {
  if (!model || typeof model !== "object") return undefined
  const item = model as { providerID?: unknown; modelID?: unknown; id?: unknown }
  if (typeof item.providerID !== "string") return undefined
  if (typeof item.modelID === "string") {
    return {
      providerID: item.providerID,
      modelID: item.modelID,
    }
  }
  if (typeof item.id === "string") {
    return {
      providerID: item.providerID,
      modelID: item.id,
    }
  }
  return undefined
}
