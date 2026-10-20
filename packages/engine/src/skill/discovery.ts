import path from "path"
import { mkdir, rename } from "fs/promises"
import { randomUUID } from "crypto"
import { Log } from "@merakcode/log/logger"
import { Global } from "../global"
import { Filesystem } from "@merakcode/util/filesystem"

export namespace Discovery {
  const log = Log.create({ service: "skill-discovery" })

  type Index = {
    skills: Array<{
      name: string
      description: string
      files: string[]
    }>
  }

  export function dir() {
    return path.join(Global.Path.cache, "skills")
  }

  async function get(url: string, dest: string): Promise<boolean> {
    // Skip if already downloaded. There is a race between the exists check and the write: two concurrent pulls of the
    // same url both see no file and write the same dest, and interleaved streams corrupt it. Each writer therefore uses
    // its own temp file and renames it atomically; the last rename wins and dest is always complete.
    if (await Filesystem.isFile(dest)) return true
    return fetch(url)
      .then(async (response) => {
        if (!response.ok) {
          log.error("failed to download", { url, status: response.status })
          return false
        }
        const tmp = `${dest}.${randomUUID()}.tmp`
        await Filesystem.write(tmp, await response.text())
        await rename(tmp, dest)
        return true
      })
      .catch((err) => {
        log.error("failed to download", { url, err })
        return false
      })
  }

  export async function pull(url: string): Promise<string[]> {
    const result: string[] = []
    const base = url.endsWith("/") ? url : `${url}/`
    const index = new URL("index.json", base).href
    const cache = dir()
    const host = base.slice(0, -1)

    log.info("fetching index", { url: index })
    const data = await fetch(index)
      .then(async (response) => {
        if (!response.ok) {
          log.error("failed to fetch index", { url: index, status: response.status })
          return undefined
        }
        return response
          .json()
          .then((json) => json as Index)
          .catch((err) => {
            log.error("failed to parse index", { url: index, err })
            return undefined
          })
      })
      .catch((err) => {
        log.error("failed to fetch index", { url: index, err })
        return undefined
      })

    if (!data?.skills || !Array.isArray(data.skills)) {
      log.warn("invalid index format", { url: index })
      return result
    }

    const list = data.skills.filter((skill) => {
      if (!skill?.name || !Array.isArray(skill.files)) {
        log.warn("invalid skill entry", { url: index, skill })
        return false
      }
      return true
    })

    await Promise.all(
      list.map(async (skill) => {
        const root = path.join(cache, skill.name)
        await Promise.all(
          skill.files.map(async (file) => {
            const link = new URL(file, `${host}/${skill.name}/`).href
            const dest = path.join(root, file)
            await mkdir(path.dirname(dest), { recursive: true })
            await get(link, dest)
          }),
        )

        const md = path.join(root, "SKILL.md")
        if (await Filesystem.isFile(md)) result.push(root)
      }),
    )

    return result
  }
}
