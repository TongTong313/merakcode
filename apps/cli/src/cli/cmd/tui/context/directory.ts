import { createMemo } from "solid-js"
import { useProject } from "./project"
import { useSync } from "./sync"
import { Paths } from "@merakcode/util/paths"

export function useDirectory() {
  const project = useProject()
  const sync = useSync()
  return createMemo(() => {
    const directory = project.directory() || process.cwd()
    const result = directory.replace(Paths.home, "~")
    if (sync.data.vcs?.branch) return result + ":" + sync.data.vcs.branch
    return result
  })
}
