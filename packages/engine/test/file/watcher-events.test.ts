import { afterEach, expect, test } from "vitest"
import path from "path"
import { Bus } from "@merakcode/engine/infra/bus/index"
import { FileWatcher } from "@merakcode/engine/agent/workspace/file/watcher"
import { Instance } from "@merakcode/engine/infra/project/instance"
import { Filesystem } from "@merakcode/util/filesystem"
import { tmpdir } from "../fixture/fixture"

afterEach(async () => {
  await Instance.disposeAll().catch(() => undefined)
})

// The native module invokes watcher callbacks straight from the event loop without the subscriber's instance context.
// Publishing from the callback needs the instance; if the context is lost it throws and changes never reach the UI.
test("switching branches in a git repo (HEAD change) publishes a file change event", async () => {
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const head = path.join(tmp.path, ".git", "HEAD")
      const seen = new Promise<string>((resolve) => {
        Bus.subscribe(FileWatcher.Event.Updated, (event) => {
          if (path.basename(event.properties.file) === "HEAD") resolve(event.properties.event)
        })
      })
      await FileWatcher.init()
      await Filesystem.write(head, "ref: refs/heads/feature\n")
      const event = await Promise.race([seen, new Promise((resolve) => setTimeout(() => resolve("timeout"), 10_000))])
      expect(event).not.toBe("timeout")
    },
  })
})
