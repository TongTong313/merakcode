import path from "path"
import { cp, mkdir } from "fs/promises"
import matter from "gray-matter"
import { Global } from "../global"
import { Instance } from "../project/instance"
import { SkillGithub, type SkillEntry, type SkillCloneAuth } from "./github"
import { Discovery } from "./discovery"
import { Log } from "@merakcode/log/logger"
import { Filesystem } from "@merakcode/util/filesystem"

export namespace SkillInstall {
  const log = Log.create({ service: "skill-install" })

  export type Source =
    | {
        type: "github"
        url: string
        owner?: string
        repo?: string
        branch?: string
        subpath?: string
        auth?: SkillCloneAuth
      }
    | { type: "url"; url: string }

  /** Parses user input into a skill source */
  export function parse(input: string): Source | { type: "invalid" } {
    const trimmed = input.trim()
    log.info("parse input", { input, trimmed })

    if (!trimmed) {
      log.warn("empty input")
      return { type: "invalid" }
    }

    // Any Git repository URL: starts with http(s) and ends with .git
    const gitUrl = trimmed.match(/^(https?:\/\/.+?\.git)$/)
    log.info("git url match", { gitUrl: !!gitUrl, pattern: "/^(https?:\\/\\/.+?\\.git)$/" })

    if (gitUrl) {
      log.info("matched git url", { url: gitUrl[1] })
      const urlParts = gitUrl[1].split("/")
      log.info("url parts", { urlParts, length: urlParts.length })

      if (urlParts.length >= 2) {
        const repoWithGit = urlParts.pop()!
        const repo = repoWithGit.replace(/\.git$/, "")
        const owner = urlParts.pop()!
        const result = { type: "github" as const, url: gitUrl[1], owner, repo }
        log.info("parsed git url with owner/repo", result)
        return result
      }
      const result = { type: "github" as const, url: gitUrl[1] }
      log.info("parsed git url without owner/repo", result)
      return result
    }

    // GitHub repository URL without .git
    const ghUrl = trimmed.match(/^https?:\/\/github\.com\/([^/]+)\/([^/.]+?)(?:\.git)?\/?$/)
    log.info("github url match", { ghUrl: !!ghUrl })

    if (ghUrl) {
      const result = {
        type: "github" as const,
        url: `https://github.com/${ghUrl[1]}/${ghUrl[2]}.git`,
        owner: ghUrl[1],
        repo: ghUrl[2],
      }
      log.info("parsed github url", result)
      return result
    }

    // Web subdirectory links from GitHub, Gitee, etc.: https://<host>/<owner>/<repo>/(tree|blob)/<branch>/<subpath...>
    // Users usually copy this form from the repository page. It must be caught before the generic url branch below
    // (Discovery index.json protocol); otherwise <url>/index.json is fetched, GitHub returns HTML, and the list is
    // silently empty. Branch names containing "/" (e.g. feature/x) cannot be split unambiguously, so the first segment
    // is the branch and the rest the subpath; common branches such as main/master are unaffected.
    const treeUrl = trimmed.match(
      /^https?:\/\/([^/]+)\/([^/]+)\/([^/]+?)(?:\.git)?\/(?:tree|blob)\/([^/]+)(?:\/(.+?))?\/?$/,
    )
    if (treeUrl) {
      const [, host, owner, repo, branch, subpath] = treeUrl
      const result: Source = {
        type: "github",
        url: `https://${host}/${owner}/${repo}.git`,
        owner,
        repo,
        branch,
        ...(subpath ? { subpath } : {}),
      }
      log.info("parsed github tree/blob url", result)
      return result
    }

    // Repository root URL on any Git host: https://<host>/<owner>/<repo>[.git][/]
    // Covers web root addresses on gitee/gitlab/gitcode etc., often copied without .git.
    // Matches exactly two path segments starting with an alphanumeric character, so Discovery URLs such as
    // /.well-known/skills/ are not swallowed.
    const repoRoot = trimmed.match(/^https?:\/\/([^/]+)\/([a-zA-Z0-9][^/]*)\/([a-zA-Z0-9][^/]*?)(?:\.git)?\/?$/)
    if (repoRoot) {
      const [, host, owner, repo] = repoRoot
      const result = {
        type: "github" as const,
        url: `https://${host}/${owner}/${repo}.git`,
        owner,
        repo,
      }
      log.info("parsed generic git host root url", result)
      return result
    }

    // owner/repo shorthand, defaults to GitHub
    const parts = trimmed.split("/")
    log.info("owner/repo split", { parts, length: parts.length })

    if (parts.length === 2 && parts.every((p) => /^[a-zA-Z0-9._-]+$/.test(p))) {
      const result = {
        type: "github" as const,
        url: `https://github.com/${parts[0]}/${parts[1]}.git`,
        owner: parts[0],
        repo: parts[1],
      }
      log.info("parsed owner/repo format", result)
      return result
    }

    if (trimmed.startsWith("http://") || trimmed.startsWith("https://")) {
      const result = { type: "url" as const, url: trimmed }
      log.info("parsed as generic url", result)
      return result
    }

    log.warn("invalid input format", { input, trimmed })
    return { type: "invalid" }
  }

  /** Project skill directory */
  export function projectSkillsDir(): string {
    return path.join(Instance.directory, ".merakcode", "skills")
  }

  /** Global skill directory */
  export function globalSkillsDir(): string {
    return path.join(Global.Path.config, "skills")
  }

  /** All supported global skill directories */
  export function globalSkillsDirs(): string[] {
    return [globalSkillsDir()]
  }

  /** Lists installable skills */
  export async function list(source: Source) {
    if (source.type === "github") {
      // Pass branch/subpath through: a tree link clones only that branch and lists only that subdirectory
      const result = await SkillGithub.list(source.url, {
        branch: source.branch,
        subpath: source.subpath,
        auth: source.auth,
      })
      return {
        // listFromDir does not return a branch, so keep the parsed source.branch
        source: { ...source, branch: result.branch || source.branch },
        skills: result.skills,
      }
    }

    const dirs = await Discovery.pull(source.url)
    const skills: SkillEntry[] = []
    for (const dir of dirs) {
      const name = path.basename(dir)
      const mdPath = path.join(dir, "SKILL.md")
      const content = await Filesystem.readText(mdPath).catch(() => "")
      let description = ""
      if (content) {
        try {
          const data = matter(content).data
          if (typeof data?.description === "string") description = data.description
        } catch {
          // ignore
        }
      }
      skills.push({
        name,
        description,
        repoPath: dir,
        files: [], // Discovery already downloaded into dir; install copies it
      })
    }
    return { source, skills }
  }

  /** Installs the selected skills */
  export async function install(
    source: Source,
    selected: SkillEntry[],
    target: "project" | "global",
    directory?: string,
  ) {
    const destRoot =
      target === "project"
        ? directory
          ? path.join(directory, ".merakcode", "skills")
          : projectSkillsDir()
        : globalSkillsDir()
    const installed: string[] = []
    const failed: { name: string; error: string }[] = []

    // Same for github and url sources: repoPath is always a local absolute path
    for (const skill of selected) {
      try {
        const dest = path.join(destRoot, skill.name)
        await mkdir(dest, { recursive: true })
        await cp(skill.repoPath, dest, {
          recursive: true,
          force: true,
          filter: (src) => !src.includes(path.sep + ".git" + path.sep) && !src.endsWith(path.sep + ".git"),
        })
        installed.push(skill.name)
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        log.error("install failed", { skill: skill.name, err: msg })
        failed.push({ name: skill.name, error: msg })
      }
    }

    // The temporary clone is kept after install because the UI may install from the same list several times; the next
    // list/clone removes it before cloning, so the cache never goes stale.
    return { installed, failed }
  }
}
