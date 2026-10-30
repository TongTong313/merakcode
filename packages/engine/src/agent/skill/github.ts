import path from "path"
import { rm } from "fs/promises"
import matter from "gray-matter"
import { Glob } from "@merakcode/util/glob"
import { Process } from "@merakcode/util/process"
import { Log } from "@merakcode/log/logger"
import { Global } from "../../infra/global"
import { Filesystem } from "@merakcode/util/filesystem"
import { Text } from "../prompt/text"

export type SkillEntry = {
  name: string
  description: string
  repoPath: string
  /** Directory relative to the repository (POSIX), lets the UI tell same-named skills apart; "." for the root */
  path?: string
  files: string[]
}

export type SkillList = {
  branch: string
  skills: SkillEntry[]
}

/** Clone credentials for private repositories; username defaults to oauth2, which works with gitee/github PATs */
export type SkillCloneAuth = { token: string; username?: string }

export namespace SkillGithub {
  const log = Log.create({ service: "skill-github" })

  /**
   * Non-interactive git arguments: clear the credential helper and disable git's own prompts.
   * For private or missing repositories (gitee returns 401 for both), machines with credential.helper=manager open a
   * Git Credential Manager login window and the process hangs waiting for input; this makes git fail instead.
   */
  const NONINTERACTIVE_GIT_ARGS = ["-c", "credential.helper=", "-c", "credential.interactive=false"]

  /**
   * Spawn options: ignore stdin, plus environment variables as a second layer (GIT_TERMINAL_PROMPT blocks terminal
   * prompts, GCM_INTERACTIVE blocks GUI windows)
   */
  const NONINTERACTIVE_GIT_OPTS = {
    stderr: "pipe" as const,
    stdin: "ignore" as const,
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GCM_INTERACTIVE: "never", GIT_ASKPASS: "" },
  }

  /** Clone timeout in milliseconds; the environment variable override lets tests inject very short values */
  function cloneTimeoutMs() {
    return Number(process.env.MERAKCODE_SKILL_CLONE_TIMEOUT_MS ?? 30000)
  }

  /**
   * Waits for the clone process, killing it and throwing on timeout.
   * Even without prompts, a broken network can leave git unresponsive for a long time; this guarantees a return.
   */
  async function awaitClone(proc: { exited: Promise<number>; kill?: () => void }, target: string): Promise<number> {
    const ms = cloneTimeoutMs()
    const message = await Text.pick(
      {
        zh: "克隆超时（超过 {seconds}s）：{target}，请检查网络或改用公开仓库",
        en: "Clone timed out (over {seconds}s): {target}. Check the network or use a public repository",
      },
      { seconds: Math.round(ms / 1000), target },
    )
    let timer: ReturnType<typeof setTimeout> | undefined
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        proc.kill?.()
        reject(new Error(message))
      }, ms)
    })
    try {
      return await Promise.race([proc.exited, timeout])
    } finally {
      if (timer) clearTimeout(timer)
    }
  }

  /**
   * With auth, http.extraHeader is injected through GIT_CONFIG environment variables: the token stays out of argv (no
   * leaks via ps or logs), off disk and out of the remote config. Works with gitee/github PATs.
   */
  function spawnOpts(auth?: SkillCloneAuth) {
    if (!auth) return NONINTERACTIVE_GIT_OPTS
    const header = `Authorization: Basic ${btoa(`${auth.username ?? "oauth2"}:${auth.token}`)}`
    return {
      ...NONINTERACTIVE_GIT_OPTS,
      env: {
        ...NONINTERACTIVE_GIT_OPTS.env,
        GIT_CONFIG_COUNT: "1",
        GIT_CONFIG_KEY_0: "http.extraHeader",
        GIT_CONFIG_VALUE_0: header,
      },
    }
  }

  /** Deterministic temp directory; the same owner/repo reuses the same path */
  function dir(owner: string, repo: string) {
    const cache = process.env.MERAKCODE_TEST_SKILL_CACHE ?? Global.Path.cache
    return path.join(cache, "skill-clone", `${owner}-${repo}`)
  }

  /** Deterministic temp directory derived from a URL */
  function dirFromUrl(url: string) {
    const cache = process.env.MERAKCODE_TEST_SKILL_CACHE ?? Global.Path.cache
    const safeUrl = url.replace(/[^a-zA-Z0-9._-]/g, "_")
    return path.join(cache, "skill-clone", safeUrl)
  }

  /**
   * Classifies a git clone failure from stderr into an actionable, localized message.
   * It includes git's actual first error line so callers see more than a generic "could not clone"; a typical case is
   * a connection timeout from a missing proxy (the browser uses the system proxy, command-line git does not).
   */
  function describeCloneFailure(target: string, stderr: string, lang: Text.Lang): string {
    const lines = stderr.split(/\r?\n/).map((l) => l.trim())
    const detail = lines.find((l) => /^(fatal|error):/i.test(l)) ?? lines.find(Boolean) ?? ""
    const params = { target, detail }
    if (/not found|Repository not found/i.test(stderr))
      return Text.format({ zh: "仓库不存在: {target}", en: "Repository not found: {target}" }, lang, params)
    if (
      /could not read Username|could not read Password|unable to get password|unable to read password|Authentication failed|terminal prompts disabled|Invalid username or password|HTTP 40[13]|\b40[13]\b/i.test(
        stderr,
      )
    )
      // The English text must keep "Authentication failed": the desktop needsAuthPrompt looks for it (and the Chinese
      // equivalent) to show the token input
      return Text.format(
        {
          zh: "该仓库需要登录授权或不存在，请提供访问令牌后重试: {target}（git: {detail}）",
          en: "Authentication failed or the repository does not exist; provide an access token and retry: {target} (git: {detail})",
        },
        lang,
        params,
      )
    if (
      /Failed to connect|Could not connect|Couldn't connect|Could not resolve|Connection timed out|Operation timed out|Connection refused|Network is unreachable/i.test(
        stderr,
      )
    )
      return Text.format(
        {
          zh: "无法连接到远端，请检查网络或为 git 配置代理（如 git config --global http.https://github.com.proxy http://127.0.0.1:端口）。git: {detail}",
          en: "Unable to reach the remote. Check the network or configure a proxy for git (e.g. git config --global http.https://github.com.proxy http://127.0.0.1:PORT). git: {detail}",
        },
        lang,
        params,
      )
    return detail
      ? Text.format(
          { zh: "无法克隆仓库: {target}（git: {detail}）", en: "Could not clone repository: {target} (git: {detail})" },
          lang,
          params,
        )
      : Text.format({ zh: "无法克隆仓库: {target}", en: "Could not clone repository: {target}" }, lang, params)
  }

  /** Shallow clone into a temp directory with non-interactive arguments and a timeout */
  async function run(dest: string, url: string, target: string, branch?: string, auth?: SkillCloneAuth) {
    await rm(dest, { recursive: true, force: true })
    const args = [
      "git",
      ...NONINTERACTIVE_GIT_ARGS,
      "clone",
      "--depth",
      "1",
      ...(branch ? ["--branch", branch] : []),
      url,
      dest,
    ]
    const proc = Process.spawn(args, spawnOpts(auth))
    const code = await awaitClone(proc, target)
    if (code !== 0) {
      const stderr = await new Response(proc.stderr).text()
      log.error("git clone failed", { url, branch, code, stderr })
      throw new Error(describeCloneFailure(target, stderr, await Text.lang()))
    }
    return dest
  }

  function clone(owner: string, repo: string) {
    return run(dir(owner, repo), `https://github.com/${owner}/${repo}.git`, `${owner}/${repo}`)
  }

  /** Shallow clone of any Git repository; branch comes from a tree link, otherwise the default branch is cloned */
  function cloneFromUrl(url: string, branch?: string, auth?: SkillCloneAuth) {
    return run(dirFromUrl(url), url, url, branch, auth)
  }

  /**
   * Scans a local directory for skills; with subpath, only skills under that subdirectory are kept (GitHub tree links)
   */
  async function listFromDir(root: string, owner: string, repo: string, subpath?: string): Promise<SkillList> {
    const glob = new Glob("**/SKILL.md")
    const skills: SkillEntry[] = []
    // Match with POSIX separators and exactly one trailing slash, so the prefix is a directory and not a name prefix
    const prefix = subpath ? subpath.replace(/\\/g, "/").replace(/\/+$/, "") + "/" : ""

    for await (const match of glob.scan({ cwd: root, absolute: false })) {
      const rel = match.replace(/\\/g, "/")
      if (rel.includes(".git/")) continue
      if (prefix && !rel.startsWith(prefix)) continue
      const skillDir = path.dirname(match)
      const absDir = skillDir === "." ? root : path.join(root, skillDir)
      // Path relative to the repository (POSIX) for display; "." for a root SKILL.md
      const relPath = skillDir === "." ? "." : skillDir.replace(/\\/g, "/")
      let name = skillDir === "." ? "unknown" : path.basename(skillDir)
      let description = ""

      try {
        const content = await Filesystem.readText(path.join(root, match))
        const parsed = matter(content)
        const data = parsed.data as Record<string, unknown>
        if (typeof data?.description === "string") description = data.description
      } catch (err) {
        log.warn("failed to parse SKILL.md", { path: match, err })
      }

      skills.push({ name, description, repoPath: absDir, path: relPath, files: [] })
    }

    if (skills.length === 0)
      throw new Error(
        subpath
          ? await Text.pick(
              {
                zh: "子目录下未找到任何技能（SKILL.md）: {path}",
                en: "No skills (SKILL.md) found in subdirectory: {path}",
              },
              { path: subpath },
            )
          : await Text.pick(
              {
                zh: "该仓库中未找到任何技能（SKILL.md）: {repo}",
                en: "No skills (SKILL.md) found in this repository: {repo}",
              },
              { repo: `${owner}/${repo}` },
            ),
      )

    return { branch: "", skills }
  }

  /** Lists installable skills by cloning the repository and scanning it */
  export async function list(owner: string, repo: string): Promise<SkillList>
  /** Lists installable skills from any Git repository; opts may carry branch/subpath from a GitHub tree link */
  export async function list(
    url: string,
    opts?: { branch?: string; subpath?: string; auth?: SkillCloneAuth },
  ): Promise<SkillList>
  export async function list(
    param1: string,
    param2?: string | { branch?: string; subpath?: string; auth?: SkillCloneAuth },
  ): Promise<SkillList> {
    if (typeof param2 === "string") {
      const root = await clone(param1, param2)
      return listFromDir(root, param1, param2)
    }
    const root = await cloneFromUrl(param1, param2?.branch, param2?.auth)
    return listFromDir(root, param1, "", param2?.subpath)
  }

  /** Removes the temporary clone directory */
  export async function cleanup(owner: string, repo: string): Promise<void>
  /** Removes the temporary clone directory of a URL */
  export async function cleanup(url: string): Promise<void>
  export async function cleanup(param1: string, param2?: string): Promise<void> {
    if (param2) {
      await rm(dir(param1, param2), { recursive: true, force: true })
    } else {
      await rm(dirFromUrl(param1), { recursive: true, force: true })
    }
  }
}
