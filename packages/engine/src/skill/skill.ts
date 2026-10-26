import z from "zod"
import path from "path"
import os from "os"
import { Config } from "../config/config"
import { Instance } from "../project/instance"
import { NamedError } from "@merakcode/util/error"
import { ConfigMarkdown } from "../config/markdown"
import { Log } from "@merakcode/log/logger"
import { Global } from "../global"
import { Filesystem } from "@merakcode/util/filesystem"
import { Flag } from "../flag/flag"
import { Bus } from "../bus"
import { BusEvent } from "../bus/bus-event"
import { Session } from "../session"
import { Message } from "../session/message"
import { Discovery } from "./discovery"
import * as Builtin from "./builtin"
import { configDirScope } from "./scope"
import { Glob } from "@merakcode/util/glob"

export namespace Skill {
  const log = Log.create({ service: "skill" })

  // Broadcast by SkillWatch when SKILL.md files change externally; clients refetch the skill list and slash commands
  // without reopening settings or restarting.
  export const Event = {
    Updated: BusEvent.define("skill.updated", z.object({})),
  }

  // One physical skill installation; a skill installed in both project and global scope has one entry each
  export const Info = z.object({
    name: z.string(),
    description: z.string(),
    location: z.string(),
    content: z.string(),
    /** Scope of this installation (global, project or built-in) */
    scope: z.enum(["global", "project", "builtin"]).optional(),
  })
  export type Info = z.infer<typeof Info>

  export type Scope = "global" | "project" | "builtin"

  type SkillEntry = {
    name: string
    description: string
    location: string
    content: string
    scope: Scope
  }

  export const InvalidError = NamedError.create(
    "SkillInvalidError",
    z.object({
      path: z.string(),
      message: z.string().optional(),
      issues: z.custom<z.core.$ZodIssue[]>().optional(),
    }),
  )

  export const NameMismatchError = NamedError.create(
    "SkillNameMismatchError",
    z.object({
      path: z.string(),
      expected: z.string(),
      actual: z.string(),
    }),
  )

  const EXTERNAL_DIRS = [".claude", ".agents"]
  const EXTERNAL_SKILL_GLOB = new Glob("skills/**/SKILL.md")

  const MERAKCODE_SKILL_GLOB = new Glob("{skill,skills}/**/SKILL.md")
  const SKILL_GLOB = new Glob("**/SKILL.md")

  export const state = Instance.state(async () => {
    const installs: SkillEntry[] = []
    const dirs = new Set<string>()

    const hasUserSkillName = (name: string) => installs.some((i) => i.name === name && i.scope !== "builtin")

    const addSkill = async (match: string, scope: Scope) => {
      if (match.startsWith("<builtin>/")) {
        const skillName = match.split("/")[1]
        const builtinSkill = Builtin.getBuiltinSkill(skillName)
        if (!builtinSkill) return
        if (hasUserSkillName(builtinSkill.name)) return
        if (installs.some((i) => i.name === builtinSkill.name && i.scope === "builtin")) return

        installs.push({
          name: builtinSkill.name,
          description: builtinSkill.description,
          location: match,
          content: builtinSkill.content,
          scope: "builtin",
        })
        return
      }

      if (installs.some((i) => i.location === match)) return

      const md = await ConfigMarkdown.parse(match).catch((err) => {
        const reason = ConfigMarkdown.FrontmatterError.isInstance(err)
          ? err.data.message
          : `Failed to parse skill ${match}`
        Bus.publish(Session.Event.Error, {
          error: new Message.ConfigParseError({
            kind: "skill",
            path: match,
            reason,
            messageKey: "error.configParse",
            params: { kind: "skill", path: match, reason },
            message: `Failed to parse skill ${match}: ${reason}`,
          }).toObject(),
        })
        log.error("failed to load skill", { skill: match, err })
        return undefined
      })

      if (!md) return

      const data = (md.data && typeof md.data === "object" ? md.data : {}) as Record<string, unknown>
      const skillName =
        typeof data.name === "string" && data.name.length > 0
          ? data.name
          : typeof data.slug === "string" && data.slug.length > 0
            ? data.slug
            : typeof data.display_name === "string" && data.display_name.length > 0
              ? data.display_name
              : path.basename(path.dirname(match))
      const description = typeof data.description === "string" ? data.description : ""

      const sameScope = installs.find((i) => i.name === skillName && i.scope === scope)
      if (sameScope) {
        log.warn("duplicate skill at scope", { name: skillName, scope, existing: sameScope.location, duplicate: match })
        return
      }

      const otherScope = installs.find((i) => i.name === skillName && i.scope !== scope && i.scope !== "builtin")
      if (otherScope) {
        log.warn("duplicate skill name across scopes", {
          name: skillName,
          existing: otherScope.location,
          duplicate: match,
          scope,
        })
      }

      dirs.add(path.dirname(match))
      installs.push({
        name: skillName,
        description,
        location: match,
        content: md.content,
        scope,
      })
    }

    const scanExternal = async (root: string, scope: Scope) => {
      return Array.fromAsync(
        EXTERNAL_SKILL_GLOB.scan({
          cwd: root,
          absolute: true,
          onlyFiles: true,
          followSymlinks: true,
          dot: true,
        }),
      )
        .then((matches) => Promise.all(matches.map((m) => addSkill(m, scope))))
        .catch((error) => {
          log.error(`failed to scan ${scope} skills`, { dir: root, error })
        })
    }

    if (!Flag.MERAKCODE_DISABLE_EXTERNAL_SKILLS) {
      for (const dir of EXTERNAL_DIRS) {
        const root = path.join(Global.Path.home, dir)
        if (!(await Filesystem.isDir(root))) continue
        await scanExternal(root, "global")
      }

      for await (const root of Filesystem.up({
        targets: EXTERNAL_DIRS,
        start: Instance.directory,
        stop: Instance.worktree,
      })) {
        await scanExternal(root, "project")
      }
    }

    const configDirs = await Config.directories()
    log.debug("Config.directories() returned", { directories: configDirs, worktree: Instance.worktree })
    for (const dir of configDirs) {
      const scope: Scope = configDirScope(dir)
      log.debug("scanning skills from config dir", { dir, scope, worktree: Instance.worktree })
      let matchCount = 0
      for await (const match of MERAKCODE_SKILL_GLOB.scan({
        cwd: dir,
        absolute: true,
        onlyFiles: true,
        followSymlinks: true,
      })) {
        await addSkill(match, scope)
        matchCount++
      }
      log.debug("finished scanning config dir", { dir, scope, matchCount })
    }

    const config = await Config.get()
    for (const skillPath of config.skills?.paths ?? []) {
      const expanded = skillPath.startsWith("~/") ? path.join(os.homedir(), skillPath.slice(2)) : skillPath
      const resolved = path.isAbsolute(expanded) ? expanded : path.join(Instance.directory, expanded)
      if (!(await Filesystem.isDir(resolved))) {
        log.warn("skill path not found", { path: resolved })
        continue
      }
      for await (const match of SKILL_GLOB.scan({
        cwd: resolved,
        absolute: true,
        onlyFiles: true,
        followSymlinks: true,
      })) {
        await addSkill(match, expanded.startsWith(os.homedir()) ? "global" : "project")
      }
    }

    for (const url of config.skills?.urls ?? []) {
      const list = await Discovery.pull(url)
      for (const dir of list) {
        dirs.add(dir)
        for await (const match of SKILL_GLOB.scan({
          cwd: dir,
          absolute: true,
          onlyFiles: true,
          followSymlinks: true,
        })) {
          await addSkill(match, "global")
        }
      }
    }

    const builtinSkills = await Builtin.scanBuiltinSkills()
    for (const match of builtinSkills) {
      await addSkill(match, "builtin")
    }
    dirs.add(Builtin.getBuiltinSkillsDir())

    const skills: Info[] = installs.map((entry) => ({
      name: entry.name,
      description: entry.description,
      location: entry.location,
      content: entry.content,
      scope: entry.scope,
    }))

    return {
      skills,
      dirs: Array.from(dirs),
    }
  })

  export async function get(name: string) {
    return state().then((x) => x.skills.find((s) => s.name === name))
  }

  export async function all() {
    return state().then((x) => x.skills)
  }

  export async function dirs() {
    return state().then((x) => x.dirs)
  }

  /**
   * Skill names written as /name at the start of the text or after whitespace.
   * A slash inside a path or URL is not a mention. Each name is returned once, in order.
   */
  export function mentioned(text: string, names: ReadonlySet<string>): string[] {
    const found: string[] = []
    for (const match of text.matchAll(/(?:^|\s)\/([^\s]+)/g)) {
      const name = match[1]
      if (!name || !names.has(name) || found.includes(name)) continue
      found.push(name)
    }
    return found
  }
}
