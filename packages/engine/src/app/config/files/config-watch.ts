import { createConfigWatch } from "../../../infra/config/watch"
import { Global } from "../../../infra/global"
import { Flag } from "../../../infra/flag/flag"
import { Bus } from "../../../infra/bus"
import { GlobalBus } from "../../../infra/bus/global"
import { Instance } from "../../../infra/project/instance"
import { Config } from "./config"

/** Application reactions to changes reported by the shared configuration watcher. */
export const ConfigWatch = createConfigWatch({
  globalDirectory: () => Global.Path.config,
  globalFiles: ["merakcode.json", "merakcode.jsonc"],
  projectFile: Config.projectMerakCodeFile,
  disabled: () => Flag.MERAKCODE_DISABLE_CONFIG_WATCH,
  globalChanged() {
    Config.global.reset()
    Config.state.invalidateAll()
    void Bus.publishGlobal(Config.UpdatedEvent, {})
    if (Instance.has()) void Bus.publish(Config.UpdatedEvent, {}).catch(() => undefined)
  },
  projectChanged(directory) {
    Config.state.invalidate()
    GlobalBus.emit("event", {
      directory,
      payload: { type: Config.UpdatedEvent.type, properties: {} },
    })
  },
})
