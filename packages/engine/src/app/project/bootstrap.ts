import { cleanupSnapshots } from "@merakcode/engine/app/project/snapshots"
import { Plugin } from "../../agent/plugin"
import { Format } from "../../agent/format"
import { LSP } from "../../agent/lsp"
import { FileWatcher } from "../../agent/workspace/file/watcher"
import { File } from "../../agent/workspace/file"
import { Project } from "../../infra/project/project"
import { Bus } from "../../infra/bus"
import { Command } from "../../agent/prompt/command"
import { Instance } from "../../infra/project/instance"
import { Vcs } from "./vcs"
import { Log } from "@merakcode/log/logger"
import { Truncate } from "../../agent/tools/truncation"
import { PermissionFlush } from "../../agent/permission/flush"
import { ConfigWatch } from "../config/files/config-watch"
import { SkillWatch } from "../../agent/skill/skill-watch"
import { RuleWatch } from "../../agent/prompt/rules/watch"
import { MemoryWatch } from "../../agent/memory/memory-watch"
import { WorkflowPartSync } from "../task/workflow/part-sync"
import { CronScheduler } from "../task/cron"
import { Scheduler } from "../../infra/scheduler"
import { Transcript } from "../../agent/session/transcript"
import { installTaskCapabilities } from "../task/install"
import { installPluginClient } from "../server/plugin-client"

export async function InstanceBootstrap() {
  installTaskCapabilities()
  installPluginClient()
  Log.Default.info("bootstrapping", { directory: Instance.directory })
  await Plugin.init()
  Format.init()
  await LSP.init()
  ConfigWatch.initGlobal()
  ConfigWatch.initInstance()
  SkillWatch.initGlobal()
  SkillWatch.initInstance()
  RuleWatch.initGlobal()
  RuleWatch.initInstance()
  MemoryWatch.initInstance()
  FileWatcher.init()
  File.init()
  Vcs.init()
  Scheduler.register({
    id: "snapshot.cleanup",
    interval: 24 * 60 * 60 * 1000,
    run: cleanupSnapshots,
    scope: "instance",
  })
  Scheduler.register({
    id: "tool.truncation.cleanup",
    interval: 60 * 60 * 1000,
    run: Truncate.cleanup,
    scope: "global",
  })
  PermissionFlush.init()
  WorkflowPartSync.init()
  // One background storage cleanup per process: deletes sessions past retention and temp files left by crashes
  Transcript.schedule()
  // Restore this project's persisted /loop tasks
  await CronScheduler.recover()
  Bus.subscribe(Command.Event.Executed, async (payload) => {
    if (payload.properties.name === Command.Default.INIT) {
      await Project.setInitialized(Instance.project.id)
    }
  })
}
