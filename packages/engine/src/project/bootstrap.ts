import { Plugin } from "../plugin"
import { Format } from "../format"
import { LSP } from "../lsp"
import { FileWatcher } from "../file/watcher"
import { File } from "../file"
import { Project } from "./project"
import { Bus } from "../bus"
import { Command } from "../command"
import { Instance } from "./instance"
import { Vcs } from "./vcs"
import { Log } from "@merakcode/log/logger"
import { Snapshot } from "../snapshot"
import { Truncate } from "../tool/truncation"
import { PermissionFlush } from "../permission/flush"
import { ConfigWatch } from "../config/config-watch"
import { SkillWatch } from "../skill/skill-watch"
import { RuleWatch } from "../rule/watch"
import { MemoryWatch } from "../memory/memory-watch"
import { WorkflowPartSync } from "../workflow/part-sync"
import { LoopScheduler } from "../scheduler/loop"
import { Transcript } from "../session/transcript"

export async function InstanceBootstrap() {
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
  Snapshot.init()
  Truncate.init()
  PermissionFlush.init()
  WorkflowPartSync.init()
  // One background storage cleanup per process: deletes sessions past retention and temp files left by crashes
  Transcript.schedule()
  // Restore this project's persisted /loop tasks
  await LoopScheduler.recover()
  Bus.subscribe(Command.Event.Executed, async (payload) => {
    if (payload.properties.name === Command.Default.INIT) {
      await Project.setInitialized(Instance.project.id)
    }
  })
}
